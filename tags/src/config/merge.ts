import { ITEM_KINDS, type ItemKind, itemKey, same } from "./diff";
import type { ContainerConfig } from "./schema";

/**
 * Merge an imported config into the draft. Pure.
 * - mode "overwrite": the import replaces the draft.
 * - mode "merge": items are matched by key (tags/triggers: id; variables/conversions: name).
 *   New keys are added; an identical item is unchanged; on a conflict, on_conflict decides:
 *   "overwrite" (the import's wins), "skip" (the draft's stays) or "rename" (the import's is
 *   added as <key>_2, and the import's own references to it are rewritten). consent, consent_banner and settings
 *   merge key by key (the import wins on overwrite, the draft otherwise).
 * Re-running the same import changes nothing, whatever on_conflict is.
 */

export type ConflictRule = "overwrite" | "rename" | "skip";
export interface MergeCounts {
  added: string[];
  replaced: string[];
  renamed: { from: string; to: string }[];
  skipped: string[];
  unchanged: string[];
}
type Item = Record<string, unknown>;
const isObj = (v: unknown): v is Item => !!v && typeof v === "object" && !Array.isArray(v);

/** Rewrite references to renamed triggers, variables and tags inside an (imported) config. */
export function renameRefs(
  cfg: ContainerConfig,
  maps: { triggers: Map<string, string>; variables: Map<string, string>; tags: Map<string, string> },
): ContainerConfig {
  const t = (id: string) => maps.triggers.get(id) ?? id;
  const v = (n: string) => maps.variables.get(n) ?? n;
  const tpl = (x: unknown): unknown => {
    if (typeof x === "string")
      return maps.variables.size ? x.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/g, (_, n: string) => `{{${v(n)}}}`) : x;
    if (Array.isArray(x)) return x.map(tpl);
    if (isObj(x)) return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, tpl(y)]));
    return x;
  };
  const out = structuredClone(cfg) as Record<string, Item[] | undefined>;
  for (const tr of out.triggers ?? []) {
    if (Array.isArray(tr.triggers)) tr.triggers = (tr.triggers as string[]).map(t);
    for (const c of (tr.conditions as Item[] | undefined) ?? []) c.var = v(c.var as string);
  }
  for (const tag of out.tags ?? []) {
    tag.triggers = (tag.triggers as string[]).map(t);
    if (tag.exclude_triggers) tag.exclude_triggers = (tag.exclude_triggers as string[]).map(t);
    if (isObj(tag.after)) tag.after.tag = maps.tags.get(tag.after.tag as string) ?? tag.after.tag;
    const params = tpl(tag.params) as Item;
    for (const k of ["event_params_from", "config_params_from"]) if (typeof params[k] === "string") params[k] = v(params[k] as string);
    tag.params = params;
  }
  for (const c of out.conversions ?? []) {
    c.trigger = t(c.trigger as string);
    for (const k of ["value", "transaction_id", "items"]) if (typeof c[k] === "string") c[k] = v(c[k] as string);
    if (isObj(c.currency)) c.currency.var = v(c.currency.var as string);
    if (isObj(c.user_data)) c.user_data = Object.fromEntries(Object.entries(c.user_data).map(([k, n]) => [k, v(n as string)]));
    if (c.params) c.params = tpl(c.params);
  }
  for (const x of out.variables ?? []) {
    for (const k of ["input", "source"]) if (typeof x[k] === "string") x[k] = v(x[k] as string);
    if (x.params) x.params = tpl(x.params);
  }
  return out as ContainerConfig;
}

export function mergeConfigs(
  base: ContainerConfig,
  incoming: ContainerConfig,
  opts: { mode: "merge" | "overwrite"; on_conflict: ConflictRule },
): { config: ContainerConfig; counts: Record<ItemKind, MergeCounts> } {
  const counts = Object.fromEntries(
    ITEM_KINDS.map((k) => [k, { added: [], replaced: [], renamed: [], skipped: [], unchanged: [] } as MergeCounts]),
  ) as Record<ItemKind, MergeCounts>;
  if (opts.mode === "overwrite") {
    for (const kind of ITEM_KINDS) {
      const prev = new Map(((base[kind] ?? []) as unknown as Item[]).map((i) => [itemKey(kind, i), i]));
      for (const i of (incoming[kind] ?? []) as unknown as Item[]) {
        const k = itemKey(kind, i);
        (prev.has(k) ? (same(prev.get(k), i) ? counts[kind].unchanged : counts[kind].replaced) : counts[kind].added).push(k);
      }
    }
    return { config: structuredClone(incoming), counts };
  }
  // Renames first (so the import's references can follow them), then the merge. Kinds go in
  // reference order (variables, then triggers, then tags), and an item identical to an existing
  // <key>_N (after its references are rewritten) maps to it, so re-running an import adds nothing.
  const maps = { triggers: new Map<string, string>(), variables: new Map<string, string>(), tags: new Map<string, string>() };
  if (opts.on_conflict === "rename") {
    for (const kind of ["variables", "triggers", "tags"] as const) {
      const field = kind === "variables" ? "name" : "id";
      const prev = new Map(((base[kind] ?? []) as unknown as Item[]).map((i) => [itemKey(kind, i), i]));
      const taken = new Set([...prev.keys(), ...((incoming[kind] ?? []) as unknown as Item[]).map((i) => itemKey(kind, i))]);
      for (const raw of (incoming[kind] ?? []) as unknown as Item[]) {
        const k = itemKey(kind, raw);
        const item = (renameRefs({ [kind]: [raw] } as ContainerConfig, maps)[kind] as unknown as Item[])[0]!;
        if (!prev.has(k) || same(prev.get(k), item)) continue;
        for (let n = 2; ; n++) {
          const to = `${k}_${n}`.slice(0, 64);
          const existing = prev.get(to);
          if (existing && same(existing, { ...item, [field]: to })) {
            maps[kind].set(k, to);
            break;
          }
          if (!existing && !taken.has(to)) {
            taken.add(to);
            maps[kind].set(k, to);
            break;
          }
        }
      }
    }
  }
  const renamed = renameRefs(incoming, maps);
  const out = structuredClone(base) as Record<string, unknown>;
  for (const kind of ITEM_KINDS) {
    const list = ((out[kind] as Item[] | undefined) ?? []).slice();
    const field = kind === "tags" || kind === "triggers" ? "id" : "name";
    const origKeys = ((incoming[kind] ?? []) as unknown as Item[]).map((i) => itemKey(kind, i));
    ((renamed[kind] ?? []) as unknown as Item[]).forEach((item, idx) => {
      const orig = origKeys[idx]!;
      const to = kind === "conversions" ? undefined : maps[kind].get(orig);
      const next = to ? { ...item, [field]: to } : item;
      const k = itemKey(kind, next);
      const at = list.findIndex((x) => itemKey(kind, x) === k);
      if (at === -1) {
        list.push(next);
        if (to) counts[kind].renamed.push({ from: orig, to });
        else counts[kind].added.push(k);
      } else if (same(list[at], next)) counts[kind].unchanged.push(k);
      else if (opts.on_conflict === "overwrite" || (opts.on_conflict === "rename" && kind === "conversions")) {
        // Conversion names are what backends send; they're never renamed.
        list[at] = next;
        counts[kind].replaced.push(k);
      } else counts[kind].skipped.push(k);
    });
    if (list.length || out[kind]) out[kind] = list;
  }
  for (const s of ["consent", "consent_banner", "settings"] as const) {
    const a = (base[s] ?? {}) as Item;
    const b = (incoming[s] ?? {}) as Item;
    if (!incoming[s]) continue;
    out[s] = opts.on_conflict === "overwrite" ? { ...a, ...b } : { ...b, ...a };
  }
  return { config: out as ContainerConfig, counts };
}
