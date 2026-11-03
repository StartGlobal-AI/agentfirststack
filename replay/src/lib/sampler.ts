/**
 * Write-sampling for counters that would otherwise cost a write per event (refused chunks): the
 * first event per key is written at once, later ones within `windowMs` are only counted in memory
 * and ride along with the next write after the window. Counts are approximate when the isolate or
 * object goes away with some held; that's the trade for not writing on every refusal.
 */
export class Sampler {
  private readonly held = new Map<string, { at: number; pending: number; sample: string | null }>();

  constructor(
    private readonly windowMs: number,
    private readonly maxKeys = 2_000,
  ) {}

  /** The count to write now (this event plus the ones held since the last write), or null to hold it. */
  take(key: string, now: number, sample: string | null): { count: number; sample: string | null } | null {
    const e = this.held.get(key);
    if (e && now - e.at < this.windowMs) {
      e.pending++;
      if (sample) e.sample = sample;
      return null;
    }
    const count = 1 + (e?.pending ?? 0);
    if (!e && this.held.size >= this.maxKeys) this.held.delete(this.held.keys().next().value as string);
    this.held.set(key, { at: now, pending: 0, sample: null });
    return { count, sample: sample ?? e?.sample ?? null };
  }

  /** Everything still held (e.g. before a read that reports the counts), reset to zero. */
  drain(): { key: string; count: number; sample: string | null }[] {
    const out: { key: string; count: number; sample: string | null }[] = [];
    for (const [key, e] of this.held)
      if (e.pending) {
        out.push({ key, count: e.pending, sample: e.sample });
        e.pending = 0;
        e.sample = null;
      }
    return out;
  }
}
