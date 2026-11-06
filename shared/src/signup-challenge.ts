import { hmacSha256Hex, timingSafeEqual } from "./crypto";
import { ApiError } from "./errors";
import { randomString } from "./ids";

/**
 * The signup proof of work. When the deployment-wide breaker (SIGNUP_GLOBAL_HOURLY_LIMIT) trips,
 * POST /v1/signup no longer refuses everyone: it answers 429 `proof_of_work_required` with a signed
 * `challenge` and a `difficulty`, and a retry that carries a solution goes through (the per-network
 * and per-provider limits still apply). An agent solves it in about a second; a bulk signup script
 * pays that second per account, and the difficulty rises the further the breaker is exceeded.
 *
 *   challenge  v1.<expires_ms>.<difficulty>.<random>.<sig>, sig = HMAC(INTERNAL_TOKEN) over the rest,
 *              so every app of a deployment accepts any app's challenge and nothing is stored to
 *              issue one. Valid 10 minutes, one signup each (counted in signup_log).
 *   solution   any string of up to 64 characters such that SHA-256("<challenge>:<solution>") starts
 *              with `difficulty` zero bits.
 */

export const POW_ALGORITHM = "sha256-leading-zero-bits";
export const DEFAULT_POW_DIFFICULTY = 20;
/** The most the difficulty rises above the base (each step doubles the work). */
const MAX_RISE = 4;
export const POW_TTL_MS = 10 * 60_000;
const SOLUTION = /^[\x21-\x7e]{1,64}$/;

const enc = new TextEncoder();

/** Leading zero bits of a byte string. */
export function leadingZeroBits(bytes: Uint8Array): number {
  let bits = 0;
  for (const b of bytes) {
    if (b === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(b) - 24;
  }
  return bits;
}

/** The base difficulty: SIGNUP_POW_DIFFICULTY (1-28), else 20. */
export function baseDifficulty(raw: string | undefined): number {
  const n = Number(raw);
  return raw && Number.isInteger(n) && n >= 1 && n <= 28 ? n : DEFAULT_POW_DIFFICULTY;
}

/** One more bit each time the breaker's count doubles past its limit, at most MAX_RISE more. */
export function difficultyFor(base: number, count: number, max: number): number {
  const ratio = max > 0 ? count / max : 1;
  return base + Math.max(0, Math.min(MAX_RISE, Math.floor(Math.log2(Math.max(1, ratio)))));
}

const signed = async (secret: string, payload: string) => (await hmacSha256Hex(secret, `afs-signup-pow|${payload}`)).slice(0, 32);

export async function issueChallenge(
  secret: string,
  difficulty: number,
  now = Date.now(),
): Promise<{ challenge: string; expiresAt: number }> {
  const expiresAt = now + POW_TTL_MS;
  const payload = `v1.${expiresAt}.${difficulty}.${randomString(16)}`;
  return { challenge: `${payload}.${await signed(secret, payload)}`, expiresAt };
}

export type Verdict = { ok: true; difficulty: number } | { ok: false; why: "malformed" | "expired" | "forged" | "wrong" };

/** Check a solution: a challenge we signed, not expired, and a hash with enough zero bits. */
export async function verifySolution(secret: string, challenge: unknown, solution: unknown, now = Date.now()): Promise<Verdict> {
  if (typeof challenge !== "string" || typeof solution !== "string" || challenge.length > 200 || !SOLUTION.test(solution))
    return { ok: false, why: "malformed" };
  const parts = challenge.split(".");
  if (parts.length !== 5 || parts[0] !== "v1") return { ok: false, why: "malformed" };
  const [, exp, diff, , sig = ""] = parts;
  const expiresAt = Number(exp);
  const difficulty = Number(diff);
  if (!Number.isInteger(expiresAt) || !Number.isInteger(difficulty) || difficulty < 1 || difficulty > 32)
    return { ok: false, why: "malformed" };
  if (!timingSafeEqual(sig, await signed(secret, parts.slice(0, 4).join(".")))) return { ok: false, why: "forged" };
  if (expiresAt <= now) return { ok: false, why: "expired" };
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(`${challenge}:${solution}`)));
  return leadingZeroBits(hash) >= difficulty ? { ok: true, difficulty } : { ok: false, why: "wrong" };
}

/** Ready-to-run solvers for the challenge, for the error's `solve`. */
export function solvers(challenge: string, difficulty: number) {
  return {
    node: `node -e 'const [c,d]=process.argv.slice(1),h=require("crypto");for(let n=0;;n++){const b=h.createHash("sha256").update(c+":"+n).digest();let z=0;for(const x of b){if(!x){z+=8;continue}z+=Math.clz32(x)-24;break}if(z>=+d){console.log(n);break}}' '${challenge}' ${difficulty}`,
    python: `python3 -c "import hashlib,sys,itertools;c,d=sys.argv[1],int(sys.argv[2]);print(next(n for n in itertools.count() if int.from_bytes(hashlib.sha256(f'{c}:{n}'.encode()).digest(),'big')>>(256-d)==0))" '${challenge}' ${difficulty}`,
  };
}

const RETRY_WHY: Record<Exclude<Verdict, { ok: true }>["why"] | "used", string> = {
  malformed: "The challenge or solution you sent isn't in the right form. ",
  expired: "The challenge you solved has expired. ",
  forged: "The challenge you sent wasn't issued by this deployment. ",
  wrong: "That solution doesn't give enough zero bits. ",
  used: "That challenge was already used for a signup. ",
};

/** 429 proof_of_work_required: the challenge at the top level too, so a client finds it easily. */
export class SignupChallengeError extends ApiError {
  constructor(
    readonly challenge: string,
    readonly difficulty: number,
    readonly expiresAt: number,
    retry?: keyof typeof RETRY_WHY,
  ) {
    super(
      429,
      "proof_of_work_required",
      `${retry ? RETRY_WHY[retry] : ""}New signups need a small proof of work for a while: this deployment is getting unusually many.`,
      `Find a string \`solution\` such that SHA-256 of "<challenge>:<solution>" (UTF-8) starts with ${difficulty} zero bits (about a second of CPU; \`solve\` has ready-made commands), then POST /v1/signup again with the same body plus {"challenge":"<challenge>","solution":"<solution>"} within 10 minutes. Existing keys keep working: reuse yours if you have one. Creating accounts in bulk breaks the Acceptable Use Policy (/acceptable-use).`,
      { challenge, difficulty, algorithm: POW_ALGORITHM, expires_at: expiresAt },
    );
  }

  override toJSON() {
    return {
      ...super.toJSON(),
      challenge: this.challenge,
      difficulty: this.difficulty,
      algorithm: POW_ALGORITHM,
      expires_at: this.expiresAt,
      solve: solvers(this.challenge, this.difficulty),
    };
  }
}
