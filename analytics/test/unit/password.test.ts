import { describe, expect, it } from "vitest";
import { checkPassword, checkUnlockCookie, hashPassword, unlockCookie } from "../../src/lib/password";

describe("share passwords", () => {
  it("hash with a random salt, check in constant time, sign unlock cookies", async () => {
    const h = await hashPassword("correct horse", 1000);
    expect(h).toMatch(/^pbkdf2\$1000\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(h).not.toContain("correct horse");
    expect(await hashPassword("correct horse", 1000)).not.toBe(h);
    expect(await checkPassword("correct horse", h)).toBe(true);
    expect(await checkPassword("wrong horse", h)).toBe(false);
    expect(await checkPassword("x", "md5$1$a$b")).toBe(false);
    const now = Date.now();
    const c = await unlockCookie("salt_test", "shr_x", Math.floor(now / 1000) + 60);
    expect(await checkUnlockCookie("salt_test", "shr_x", c, now)).toBe(true);
    expect(await checkUnlockCookie("salt_test", "shr_y", c, now)).toBe(false);
    expect(await checkUnlockCookie("other", "shr_x", c, now)).toBe(false);
    expect(await checkUnlockCookie("salt_test", "shr_x", c, now + 120_000)).toBe(false);
  });
});
