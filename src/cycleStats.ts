// pattern: Functional Core
// Rolling poll-cycle outcomes — the signal the liveness heartbeat structurally
// cannot carry.
//
// data/heartbeat.json answers "when did a cycle last SUCCEED?", and the
// dead-man's-switch ages it. That catches total silence and nothing else: on
// 2026-09-20 the bot failed roughly half its cycles for a whole morning while
// the surviving half kept the stamp under the 10-minute threshold, so the
// watchdog stayed green through an effective outage. Rate, not age, is what
// distinguishes "degraded" from "fine".
//
// So this window records EVERY cycle, pass or fail, and carries the derived
// counts alongside the raw list — `recent` is the source of truth, `total` and
// `failures` are a cache written in the same atomic save so deploy/healthcheck.sh
// can read two integers with sed instead of parsing JSON in POSIX sh.

export interface CycleOutcome {
  at: string;
  ok: boolean;
}

export interface CycleStats {
  updatedAt: string;
  window: number;
  total: number;
  failures: number;
  recent: CycleOutcome[];
}

// 10 cycles ≈ 10 minutes at the default 60s poll interval: long enough that a
// single transient blip cannot trip the alert, short enough to fire inside the
// first two runs of a */5 cron rather than 20 minutes into an outage.
export const DEFAULT_CYCLE_WINDOW = 10;

// Same guard shape as caseFollows.parseInterval (the July M1 finding): a
// malformed env must fall back to the default, never produce NaN — a NaN window
// would make slice() return nothing and silently disable the whole signal.
export function parseWindow(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_CYCLE_WINDOW;
}

function isOutcome(v: unknown): v is CycleOutcome {
  if (typeof v !== "object" || v === null) return false;
  const o = v as { at?: unknown; ok?: unknown };
  return typeof o.at === "string" && typeof o.ok === "boolean";
}

export function appendCycleOutcome(
  // Prior stats read off disk — absent on first run, and hand-edited or
  // truncated in the cases worth surviving, so the shape is re-checked rather
  // than trusted.
  prev: CycleStats | null | undefined,
  ok: boolean,
  nowIso: string,
  window: number = DEFAULT_CYCLE_WINDOW,
): CycleStats {
  const prior = Array.isArray(prev?.recent)
    ? prev.recent.filter(isOutcome)
    : [];
  const kept = [...prior, { at: nowIso, ok }].slice(-window);
  return {
    updatedAt: nowIso,
    window,
    total: kept.length,
    failures: kept.filter((o) => !o.ok).length,
    recent: kept,
  };
}
