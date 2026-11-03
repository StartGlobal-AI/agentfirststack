import type { LoaderConfig } from "../lib/protocol";

/** sessionStorage afsr_<site>: one tab's recording session, shared by its page loads. */
export interface SessionState {
  id: string;
  /** started, last activity (unix ms) */
  t0: number;
  last: number;
  /** next chunk seq, last pageview number */
  seq: number;
  pv: number;
  /** 1 = sampled in */
  on: 0 | 1;
  /** 1 = forced with ?afsr=1 */
  f?: 1;
  /** why recording ended for this tab (max_duration, daily_session_limit, ...) */
  stop?: string;
  /** afsr('identify') value, kept across page loads */
  uid?: string;
}

export type Cmd = [string, ...unknown[]];

/** Handed from the loader to the recorder through window.__afsrBoot. */
export interface Boot {
  C: LoaderConfig & { base: string };
  S: SessionState;
  base: string;
  queue: Cmd[];
  state: string;
  save(): void;
  /** set by the recorder once it runs */
  cmd?: (c: Cmd) => void;
}
