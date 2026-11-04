import type { ContainerConfig } from "./schema";

/**
 * What changed between two configs (a version, the live one, or the draft), per item and per
 * section, in plain words and as JSON paths. Pure; used by GET /diff, get_draft's
 * changes_vs_live and the item-level draft endpoints.
 */

export const ITEM_KINDS = ["tags", "triggers", "variables", "conversions"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
/** The field that identifies an item of each kind (its natural key). */
export const KEY_FIELD: Record<ItemKind, "id" | "name"> = { tags: "id", triggers: "id", variables: "name", conversions: "name" };
const LABEL: Record<ItemKind, [string, string]> = {
  tags: ["tag", "tags"],
  triggers: ["trigger", "triggers"],
  variables: ["variable", "variables"],
  conversions: ["conversion", "conversions"],
};
const SECTIONS = ["consent", "settings"] as const;

export interface PathChange {
  path: string;
  from?: unknown;
  to?: unknown;
}
export interface ItemChange {
  kind: ItemKind;
  key: string;
  type?: string;
  change: "added" | "removed" | "changed";
  paths?: PathChange[];
  text: string;
}
export interface SectionChange {
  section: (typeof SECTIONS)[number];
  change: "added" | "removed" | "changed";
  paths: PathChange[];
  text: string;
}
export interface ConfigDiff {
  identical: boolean;
  summary: string;
  counts: { added: number; removed: number; changed: number };
  changes: ItemChange[];
  sections: SectionChange[];
  /** Kinds whose shared items are in a different order (tags fire in array order, ties of priority). */
  order_changed: ItemKind[];
}

type Item = Record<string, unknown>;
const MAX_PATHS = 50;

export const itemKey = (kind: ItemKind, item: Item) => String(item[KEY_FIELD[kind]] ?? "");

/** A value as shown in a diff: long strings and nested values are clipped. */
export function shown(v: unknown): unknown {
  if (typeof v === "string") return v.length > 120 ? `${v.slice(0, 120)}...(${v.length} chars)` : v;
  if (v && typeof v === "object") {
    const s = JSON.stringify(v);
    return s.length > 200 ? `${s.slice(0, 200)}...(${s.length} chars)` : v;
  }
  return v;
}

/** JSON with object keys sorted, so two configs that differ only in key order compare equal. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v) ?? "null";
}
export const same = (a: unknown, b: unknown) => stableJson(a) === stableJson(b);
const isPlain = (v: unknown): v is Item => !!v && typeof v === "object" && !Array.isArray(v);

/** Leaf-level differences between two JSON values (objects recurse; arrays compare whole). */
export function pathDiff(a: unknown, b: unknown, prefix = "", out: PathChange[] = []): PathChange[] {
  if (out.length >= MAX_PATHS || same(a, b)) return out;
  if (isPlain(a) && isPlain(b)) {
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      pathDiff(a[k], b[k], prefix ? `${prefix}.${k}` : k, out);
      if (out.length >= MAX_PATHS) break;
    }
    return out;
  }
  out.push({
    path: prefix || "(whole)",
    ...(a === undefined ? {} : { from: shown(a) }),
    ...(b === undefined ? {} : { to: shown(b) }),
  });
  return out;
}

const q = (v: unknown) => (typeof v === "string" ? `"${v}"` : JSON.stringify(v));
function describePaths(paths: PathChange[]): string {
  const parts = paths.slice(0, 5).map((p) => {
    if (!("from" in p)) return `${p.path} set to ${q(p.to)}`;
    if (!("to" in p)) return `${p.path} removed (was ${q(p.from)})`;
    return `${p.path} ${q(p.from)} -> ${q(p.to)}`;
  });
  return parts.join("; ") + (paths.length > 5 ? `; and ${paths.length - 5} more` : "");
}

function itemsOf(cfg: ContainerConfig | null | undefined, kind: ItemKind): Item[] {
  return ((cfg?.[kind] ?? []) as unknown[]).filter(isPlain);
}

export function diffConfigs(from: ContainerConfig | null | undefined, to: ContainerConfig | null | undefined): ConfigDiff {
  const changes: ItemChange[] = [];
  const sections: SectionChange[] = [];
  const order_changed: ItemKind[] = [];
  for (const kind of ITEM_KINDS) {
    const a = itemsOf(from, kind);
    const b = itemsOf(to, kind);
    const am = new Map(a.map((i) => [itemKey(kind, i), i]));
    const bm = new Map(b.map((i) => [itemKey(kind, i), i]));
    const [one] = LABEL[kind];
    const title = (k: string, i: Item) =>
      `${one[0]!.toUpperCase()}${one.slice(1)} "${k}"${typeof i.type === "string" ? ` (${i.type})` : ""}`;
    for (const [k, i] of am) {
      if (!bm.has(k))
        changes.push({ kind, key: k, type: i.type as string | undefined, change: "removed", text: `${title(k, i)} removed.` });
    }
    for (const [k, i] of bm) {
      const prev = am.get(k);
      if (!prev) changes.push({ kind, key: k, type: i.type as string | undefined, change: "added", text: `${title(k, i)} added.` });
      else if (!same(prev, i)) {
        const paths = pathDiff(prev, i);
        changes.push({
          kind,
          key: k,
          type: i.type as string | undefined,
          change: "changed",
          paths,
          text: `${title(k, i)} changed: ${describePaths(paths)}.`,
        });
      }
    }
    const shared = (list: Item[], other: Map<string, Item>) => list.map((i) => itemKey(kind, i)).filter((k) => other.has(k));
    if (!same(shared(a, bm), shared(b, am))) order_changed.push(kind);
  }
  for (const s of SECTIONS) {
    const a = from?.[s];
    const b = to?.[s];
    if (same(a ?? null, b ?? null)) continue;
    const paths = pathDiff(a ?? {}, b ?? {});
    const change = a === undefined ? "added" : b === undefined ? "removed" : "changed";
    sections.push({ section: s, change, paths, text: `${s} ${change}: ${describePaths(paths)}.` });
  }
  const counts = {
    added: changes.filter((c) => c.change === "added").length,
    removed: changes.filter((c) => c.change === "removed").length,
    changed: changes.filter((c) => c.change === "changed").length,
  };
  const identical = !changes.length && !sections.length && !order_changed.length;
  return { identical, summary: summarize(changes, sections, order_changed), counts, changes, sections, order_changed };
}

function summarize(changes: ItemChange[], sections: SectionChange[], order: ItemKind[]): string {
  if (!changes.length && !sections.length && !order.length) return "No changes.";
  const parts: string[] = [];
  for (const kind of ITEM_KINDS) {
    for (const change of ["added", "changed", "removed"] as const) {
      const keys = changes.filter((c) => c.kind === kind && c.change === change).map((c) => c.key);
      if (!keys.length) continue;
      const [one, many] = LABEL[kind];
      const list = keys.slice(0, 5).join(", ") + (keys.length > 5 ? `, +${keys.length - 5}` : "");
      parts.push(`${keys.length} ${keys.length === 1 ? one : many} ${change} (${list})`);
    }
  }
  for (const s of sections) parts.push(`${s.section} ${s.change}`);
  for (const k of order) parts.push(`${k} reordered`);
  return `${parts.join(", ")}.`;
}
