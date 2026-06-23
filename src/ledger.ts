// pattern: Functional Core (pure ledger ops) + thin I/O shell (load / save)
// Persistent record of provisioned cases (CL docket id -> account) for dedupe,
// plus a per-day CourtListener request counter so on-demand provisioning stays
// under the shared free-tier cap. Holds per-case account passwords, so it lives
// in the gitignored data/ directory.
//
// LOCK CONTRACT: both the always-on bot and the operator CLI read-modify-write
// this file, so every such cycle MUST go through mutateLedger (advisory lock +
// re-read under the lock). A bare saveLedger overwrites the whole file and can
// clobber a concurrent writer's quota charge or recordCase entry — use it only
// for a from-scratch write (tests/init), never for an increment/merge.

import { createHash } from "node:crypto";
import { loadJson, mutateJson, saveJson } from "./atomicJson.js";

export interface CaseEntry {
  did: string;
  handle: string;
  password: string;
  createdAt: string;
  // Set true ONLY by the terminal recordCase, after DNS + records + backfill all
  // succeed. A present-but-incomplete entry is a crash zombie (credentials were
  // persisted early so the account/password isn't orphaned), NOT a finished case:
  // the dedupe guard must resume it, not report it as already provisioned.
  completed?: boolean;
  // High-water recapSequenceNumber for the watched-case monitor: the monitor only
  // posts entries whose recapSequenceNumber sorts ABOVE this, then advances it to
  // the highest actually-posted entry.
  highWater?: string;
  // ISO timestamp of the monitor's last poll of this case. Drives the per-case
  // cadence gate (re-checked only after MONITOR_INTERVAL_MS) so the monitor
  // spreads its CL calls instead of re-fetching every case every cycle.
  lastCheckedAt?: string;
  // rkeys whose backdated doc-post failed during backfill — entries that exist
  // as records but have no companion post yet (repair target).
  backfillFailed?: string[];
  // Case facts snapshot for the reply link card (see card.ts). Persisted at
  // provision so the dedupe ("exists") reply can build the same rich card
  // without a CL fetch. Absent on entries written before cards existed → the
  // card falls back to a generic title.
  caseName?: string;
  docketNumber?: string;
  courtName?: string;
  filings?: number;
  // Prior accounts displaced by a --force re-provision of the same docket. Kept
  // so a superseded account's credentials are never silently lost (the ledger
  // is the only credential store).
  superseded?: CaseEntry[];
}

export interface Ledger {
  cases: Record<string, CaseEntry>;
  // Per-token daily request counters. CourtListener's 125/day cap is PER TOKEN,
  // so a pool of N tokens gives N independent daily budgets. `counts` is keyed
  // by a non-secret token fingerprint (tokenId); all counters reset on a new day.
  quota: { day: string; counts: Record<string, number> };
  // Per-token hourly-throttle cooldown: ISO timestamp until which a token should
  // not be used, keyed by tokenId. Set when a provision hits CL's 50/hr window
  // (which, unlike the daily cap, does NOT reset at the UTC day boundary), so the
  // drain doesn't re-discover the same throttle one queued case at a time. Stale
  // (past) entries are ignored, so they need no cleanup.
  throttledUntil?: Record<string, string>;
  // Per-token rolling call log: ascending ms-epoch timestamps of CL requests in
  // the last 24h, keyed by tokenId. This is the PREDICTIVE counterpart to `quota`
  // (which resets on the calendar day): CL enforces 5/min·50/hr·125/day as ROLLING
  // windows, so right after our 8pm-ET calendar reset the day-counter reads fresh
  // while CL still remembers the prior ~24h and 429s us (the 2026-06-16 freeze).
  // The log lets selectToken/classifyDeferral stop a drain BEFORE the 429 and
  // report the exact reopen time. Pruned to 24h on every record (bounded ≤~125).
  calls?: Record<string, number[]>;
  // Watchlist sweeper cadence marker. `sweptAt` is the ISO time of the last list
  // feed read; the sweeper re-reads only after RCAPE_WATCHLIST_INTERVAL_MS, so a
  // 60s poll loop doesn't hammer the AppView's getListFeed. Absent ⇒ never swept.
  watchlist?: { sweptAt?: string };
  // Pre-shelve harvest cadence marker (same role as `watchlist` above, for the
  // private journalist-feed harvest). Absent ⇒ never harvested.
  harvest?: { sweptAt?: string };
  // Public-directory state. `listRkey` is the TID rkey of the followable
  // app.bsky.graph.list ("shelf") of case accounts. app.bsky.graph.list is
  // key:tid in its lexicon, so the rkey MUST be a valid TID (not a fixed string);
  // it's minted once and persisted here so the list's AT-URI stays stable across
  // restarts/regenerations — followers reference that URI, so it must never change.
  directory?: { listRkey?: string };
}

// CourtListener free tier: 125 requests/day per token.
export const DAILY_CAP = 125;

// --- Budget priority ladder (single source) -------------------------------
// All callers that gate a CL-spending action on remaining quota draw their
// "require this much free budget before starting" floor from HERE, so the
// fairness ordering can't silently invert when one literal is bumped. The
// invariant — by-request <= monitor < watchlist < harvest — is asserted by a
// test (ledger.test.ts) and re-asserted at module load (assertFloorOrdering).
//
// Each rung is a MIN_QUOTA_FOR_CASE-derived figure: a lower-priority sweep must
// leave AT LEAST a by-request case's worth of headroom on top of its own
// reservation, so it can never starve a human's on-demand provision.

// Upfront reservation charged per case before fetching, reconciled to the real
// count afterward (see provisionCase.ts for the why). The atom the floors build on.
export const RESERVED_CALLS_PER_CASE = 10;

// By-request start floor: a human @-mention. Must stay > RESERVED so the gap
// absorbs the race between the start check and the reservation charge. The
// watched-case monitor shares this exact rung (same priority as a human request,
// so it neither outranks nor is outranked) — monitor.ts imports this directly
// rather than a separate alias export, which would read as a duplicate.
export const MIN_QUOTA_FOR_CASE = RESERVED_CALLS_PER_CASE + 2; // 12

// Watchlist sweeper: lower priority than by-request/monitor — a token must have
// headroom for THIS case's reservation PLUS a full by-request case in reserve, so
// discretionary auto-shelving never consumes budget a human request needs. The
// historical value is 24 (= reservation + a full live request worth of slack);
// kept exactly while clamping the lower bound to the ladder-derived minimum.
export const WATCHLIST_FLOOR_DEFAULT = Math.max(
  RESERVED_CALLS_PER_CASE + MIN_QUOTA_FOR_CASE, // 22 ladder minimum
  24,
); // 24

// Pre-shelve harvest: lowest priority — bulk overnight work that must yield to
// every interactive path. Far above the others so a backlog never crowds them out.
export const HARVEST_FLOOR_DEFAULT = 60;

// Re-assert the fairness ladder at module load so a future edit that inverts it
// fails loudly at startup, not silently in production. by-request <= monitor <
// watchlist < harvest, where the monitor rung IS MIN_QUOTA_FOR_CASE (same rung).
function assertFloorOrdering(): void {
  const ok =
    MIN_QUOTA_FOR_CASE < WATCHLIST_FLOOR_DEFAULT &&
    WATCHLIST_FLOOR_DEFAULT < HARVEST_FLOOR_DEFAULT;
  if (!ok) {
    throw new Error(
      `budget-floor ladder inverted: expected by-request/monitor < watchlist < harvest, got ${MIN_QUOTA_FOR_CASE} < ${WATCHLIST_FLOOR_DEFAULT} < ${HARVEST_FLOOR_DEFAULT}`,
    );
  }
}
assertFloorOrdering();

// CL's per-token throttle windows for the docket endpoints. Only the 5/min cap is
// verified live (2026-06-17: the 429 body literally reads "Rate limit exceeded:
// 5/min"); the 50/hr and 125/24h figures are from CL docs / inferred, not yet
// observed in a 429 body. These are DRF SCOPED throttles, stricter than the
// 5000/hr headline that governs other scopes. `cap` is the max requests CL allows
// within `windowMs`. The 24h window is the rolling form of DAILY_CAP — what our
// calendar counter approximates badly.
const CL_RATE_WINDOWS: ReadonlyArray<{ windowMs: number; cap: number }> = [
  { windowMs: 60_000, cap: 5 }, // 5/min
  { windowMs: 3_600_000, cap: 50 }, // 50/hr
];
const CL_DAILY_WINDOW = { windowMs: 86_400_000, cap: DAILY_CAP }; // 125/24h rolling
const ROLLING_PRUNE_MS = CL_DAILY_WINDOW.windowMs; // widest window bounds the log

// Stable, non-secret fingerprint of a CL token, used as the per-token quota key
// so the raw token never lands in the (credential-bearing but still) ledger.
export function tokenId(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

export function emptyLedger(): Ledger {
  return { cases: {}, quota: { day: "", counts: {} } };
}

export function findCase(
  ledger: Ledger,
  docketId: number,
): CaseEntry | undefined {
  return ledger.cases[String(docketId)];
}

// Stamp the watchlist sweeper's last-feed-read time (pure merge — preserves every
// other ledger field). Drives the sweeper's cadence gate.
export function recordWatchlistSwept(ledger: Ledger, iso: string): Ledger {
  return { ...ledger, watchlist: { ...ledger.watchlist, sweptAt: iso } };
}

// Stamp the pre-shelve harvest's last-feed-read time (pure merge). Drives the
// harvest cadence gate, mirroring recordWatchlistSwept.
export function recordHarvestSwept(ledger: Ledger, iso: string): Ledger {
  return { ...ledger, harvest: { ...ledger.harvest, sweptAt: iso } };
}

// Persist the followable graph.list's TID rkey (pure merge), minted once on the
// first directory regenerate and reused forever after — see Ledger.directory.
export function recordDirectoryListRkey(ledger: Ledger, rkey: string): Ledger {
  return { ...ledger, directory: { ...ledger.directory, listRkey: rkey } };
}

export function recordCase(
  ledger: Ledger,
  docketId: number,
  entry: CaseEntry,
): Ledger {
  const prior = ledger.cases[String(docketId)];
  let toStore = entry;
  // A genuinely different DID (the incoming entry names one AND prior already had
  // one that differs) means a --force re-provision displaced the old account.
  // A partial update that omits `did`, or filling in the DID on a credentials-
  // first pending entry (prior.did absent), is NOT a force re-provision.
  const isForceReprovision = prior?.did && entry.did && prior.did !== entry.did;
  if (isForceReprovision) {
    // Archive the displaced account (flattened) so its credentials survive. A
    // force re-provision is a full fresh entry, so no merge over prior.
    const { superseded: priorArchive, ...priorRest } = prior;
    toStore = { ...entry, superseded: [...(priorArchive ?? []), priorRest] };
  } else if (prior) {
    // Same-DID / partial update (e.g. a watched-case monitor writing only
    // highWater): merge over the prior entry so fields absent from `entry` —
    // notably the irreplaceable password — are never clobbered. Then re-apply
    // the superseded-preservation rule (a partial update never sets it).
    toStore = {
      ...prior,
      ...entry,
      superseded: entry.superseded ?? prior.superseded,
    };
  }
  return {
    ...ledger,
    cases: { ...ledger.cases, [String(docketId)]: toStore },
  };
}

// Every handle the ledger considers spoken-for: the live case handles AND the
// handles of superseded (--force-displaced) accounts, which still exist on the
// PDS with their DNS TXT. deriveHandle must avoid all of them — re-issuing a
// superseded handle would let a fresh case overwrite a still-live account's TXT.
export function takenHandles(ledger: Ledger): Set<string> {
  const taken = new Set<string>();
  for (const c of Object.values(ledger.cases)) {
    taken.add(c.handle);
    for (const s of c.superseded ?? []) taken.add(s.handle);
  }
  return taken;
}

// A pre-pool ledger stored one aggregate counter ({day, count}); the pool stores
// per-token counters keyed by tokenId. A legacy count can't be attributed to a
// token fingerprint, so on migration it's preserved under this reserved key and
// applied as a shared FLOOR to every token's usage for that day — it over-counts
// across tokens but never under-counts, so the CL cap is never exceeded. It's
// dropped on the next day-rollover (chargeQuota rebuilds counts).
const LEGACY_QUOTA_KEY = "_legacyAggregate";

// Requests left today for ONE token. A different day means that token's counter
// has reset (counters are scoped to quota.day). The legacy-aggregate floor (if a
// pre-pool ledger was migrated this day) is added to every token's usage.
export function quotaRemaining(
  ledger: Ledger,
  day: string,
  token: string,
): number {
  if (ledger.quota.day !== day) return DAILY_CAP;
  const { counts } = ledger.quota;
  const used = (counts[tokenId(token)] ?? 0) + (counts[LEGACY_QUOTA_KEY] ?? 0);
  return Math.max(0, DAILY_CAP - used);
}

// Charge `n` requests against ONE token for `day`. The day comparison is
// DIRECTIONAL so a stale charge can't corrupt the durable counters: a reconcile
// whose ~3-min case fetch straddled UTC midnight while a concurrent writer
// already rolled the day forward would otherwise reset the newer day's counts
// (wiping other tokens' reservations) and could drive a counter negative
// (masking exhaustion). Same-day charges clamp at zero (the reconcile delta is
// negative); a forward rollover resets all counters; a stale (older-day) charge
// is dropped — under-count is the safe direction.
export function chargeQuota(
  ledger: Ledger,
  n: number,
  day: string,
  token: string,
): Ledger {
  const id = tokenId(token);
  if (day === ledger.quota.day) {
    const counts = { ...ledger.quota.counts };
    counts[id] = Math.max(0, (counts[id] ?? 0) + n);
    return { ...ledger, quota: { day, counts } };
  }
  if (day > ledger.quota.day) {
    // Forward rollover (incl. the first charge on a fresh "" day): reset.
    return { ...ledger, quota: { day, counts: { [id]: Math.max(0, n) } } };
  }
  // Stale charge for an older day than the store currently holds — drop it.
  return ledger;
}

// True when `token` is inside its hourly-throttle cooldown at `nowMs`.
export function isThrottled(
  ledger: Ledger,
  token: string,
  nowMs: number,
): boolean {
  const until = ledger.throttledUntil?.[tokenId(token)];
  return until !== undefined && Date.parse(until) > nowMs;
}

// The instant a throttled token reopens (ms epoch), or undefined when the token
// carries no live cooldown. Lets the drain classify the requester notice by how
// far out the reopen is — a far-future cooldown is CL's daily window ("tomorrow")
// even when our own day-counter still shows budget, the exact mismatch that let
// the bot thrash an already-spent limit on 2026-06-16.
export function throttledUntilMs(
  ledger: Ledger,
  token: string,
  nowMs: number,
): number | undefined {
  const until = ledger.throttledUntil?.[tokenId(token)];
  if (until === undefined) return undefined;
  const ms = Date.parse(until);
  return ms > nowMs ? ms : undefined;
}

// Mark a token throttled until `untilISO` (keyed by the non-secret tokenId).
export function markTokenThrottled(
  ledger: Ledger,
  token: string,
  untilISO: string,
): Ledger {
  return {
    ...ledger,
    throttledUntil: { ...ledger.throttledUntil, [tokenId(token)]: untilISO },
  };
}

// Append `n` actual CL requests made at `nowMs` against `token`, pruning entries
// that have aged out of the 24h window so the log stays bounded. Timestamps are
// kept ascending. Charged from the real `requestCount` AFTER a fetch (not the
// upfront reservation) so the log reflects calls CL actually saw.
//
// Accepted crash-window gap: the rolling log is written only on reconcile (after
// the fetch resolves/throttles), while the CALENDAR quota is reserved upfront. A
// process crash mid-fetch therefore loses the rolling-log entries for that
// fetch's calls — but the calendar reservation persisted, so the next
// selectToken still defers on the calendar counter; the rolling gate just
// under-counts until the window rolls. We tolerate this (vs. recording the
// reservation upfront) because the upfront count would over-count on the common
// case where a case needs fewer than RESERVED calls, permanently inflating the
// rolling log with phantom calls that never age out correctly.
export function recordCalls(
  ledger: Ledger,
  token: string,
  nowMs: number,
  n: number,
): Ledger {
  const id = tokenId(token);
  const cutoff = nowMs - ROLLING_PRUNE_MS;
  const kept = (ledger.calls?.[id] ?? []).filter((t) => t > cutoff);
  for (let i = 0; i < n; i++) kept.push(nowMs);
  return { ...ledger, calls: { ...ledger.calls, [id]: kept } };
}

// Charge the calendar quota AND append to the rolling 24h log in one step, so the
// two accountings can never be updated apart (a dropped recordCalls was the
// 2026-06-16 freeze). `calls` is the requests CL actually saw — all of them land
// in the rolling log. `reserved` is any amount already charged to the calendar
// quota upfront (a provision/monitor reservation), so only the delta
// `calls - reserved` is charged to the calendar counter here; pass 0 (the default)
// for a single uncharged call (the bot's search sites).
export function chargeAndRecord(
  ledger: Ledger,
  calls: number,
  day: string,
  token: string,
  nowMs: number,
  reserved = 0,
): Ledger {
  return recordCalls(
    chargeQuota(ledger, calls - reserved, day, token),
    token,
    nowMs,
    calls,
  );
}

// The earliest time (ms epoch) at which `count` requests in the window of width
// `windowMs` (cap `cap`) leaves at least `minFree` headroom — i.e. when enough of
// the oldest in-window calls age out. Returns `nowMs` when already open. `calls`
// must be ascending. `minFree > cap` is unsatisfiable (the case can never fit the
// window) → Infinity, surfaced to the caller as "never on this token".
function windowReopenMs(
  calls: number[],
  windowMs: number,
  cap: number,
  minFree: number,
  nowMs: number,
): number {
  const allowed = cap - minFree; // max in-window calls that still leaves minFree
  if (allowed < 0) return Number.POSITIVE_INFINITY;
  const active = calls.filter((t) => t > nowMs - windowMs);
  if (active.length <= allowed) return nowMs;
  // Drop the m oldest active calls so the remainder fits; the m-th ages out of
  // the window at active[m-1] + windowMs. allowed ≥ 0 and active.length > allowed
  // here, so 1 ≤ m ≤ active.length — the index is always in range.
  const m = active.length - allowed;
  const ageOut = active[m - 1] as number;
  return ageOut + windowMs;
}

// The earliest time `token` can START a case needing `need` daily slots without
// tripping any CL throttle: the 24h window must free `need` slots; the 5/min and
// 50/hr windows need only one free slot (the fetch paces itself across them and
// the client absorbs short 429s). `need` is NOT applied to the small rate windows
// — demanding 12 free in a cap-5 minute window would be permanently unsatisfiable.
// Returns ≤ nowMs when the token is startable now.
export function rollingStartableAt(
  ledger: Ledger,
  token: string,
  need: number,
  nowMs: number,
): number {
  const calls = ledger.calls?.[tokenId(token)] ?? [];
  return Math.max(
    windowReopenMs(
      calls,
      CL_DAILY_WINDOW.windowMs,
      CL_DAILY_WINDOW.cap,
      need,
      nowMs,
    ),
    ...CL_RATE_WINDOWS.map((w) =>
      windowReopenMs(calls, w.windowMs, w.cap, 1, nowMs),
    ),
  );
}

// Pick the first configured token with at least `need` requests left today AND
// not in an hourly-throttle cooldown AND whose rolling 5/min·50/hr·125/24h windows
// are open right now, or undefined when none qualifies. A single case must run
// end-to-end on ONE token (CL pagination carries the token), so headroom can't be
// pooled across tokens — we need one token that can cover the whole case. Pass
// `nowMs` to honor the throttle cooldown AND the rolling-window prediction; omit
// it (legacy callers/tests) to consider the calendar-day quota only.
export function selectToken(
  ledger: Ledger,
  tokens: string[],
  day: string,
  need: number,
  nowMs?: number,
): string | undefined {
  return tokens.find(
    (t) =>
      quotaRemaining(ledger, day, t) >= need &&
      (nowMs === undefined ||
        (!isThrottled(ledger, t, nowMs) &&
          rollingStartableAt(ledger, t, need, nowMs) <= nowMs)),
  );
}

function normalizeQuota(q: {
  day?: string;
  count?: number; // legacy single-counter shape (pre-token-pool)
  counts?: Record<string, number>;
}): Ledger["quota"] {
  const counts = { ...(q?.counts ?? {}) };
  // Migrate a legacy aggregate into the shared-floor key so a same-day upgrade
  // doesn't silently zero today's spend (see LEGACY_QUOTA_KEY).
  if (q?.count && q.count > 0 && counts[LEGACY_QUOTA_KEY] === undefined) {
    counts[LEGACY_QUOTA_KEY] = q.count;
  }
  return { day: q?.day ?? "", counts };
}

function normalize(parsed: Partial<Ledger>): Ledger {
  const out: Ledger = {
    cases: parsed.cases ?? {},
    quota: normalizeQuota(parsed.quota ?? {}),
  };
  // Carry the per-token throttle cooldowns through load/mutate (omitted when
  // absent so legacy ledgers don't grow an empty key). Stale entries are ignored
  // at read time (isThrottled), so no expiry pass is needed here.
  if (parsed.throttledUntil) out.throttledUntil = parsed.throttledUntil;
  // Carry the rolling call log through load/mutate (omitted when absent so legacy
  // ledgers don't grow an empty key). Pruning happens at record time, not here.
  if (parsed.calls) out.calls = parsed.calls;
  // Carry the watchlist sweeper's cadence marker through load/mutate.
  if (parsed.watchlist) out.watchlist = parsed.watchlist;
  // Carry the pre-shelve harvest cadence marker through load/mutate.
  if (parsed.harvest) out.harvest = parsed.harvest;
  // Carry the public-directory state (the persisted graph.list TID rkey) through.
  if (parsed.directory) out.directory = parsed.directory;
  return out;
}

export async function loadLedger(path: string): Promise<Ledger> {
  return normalize(await loadJson<Partial<Ledger>>(path, emptyLedger));
}

export async function saveLedger(path: string, ledger: Ledger): Promise<void> {
  await saveJson(path, ledger);
}

// Cross-process-safe read-modify-write of the ledger: re-reads under an advisory
// lock, applies `mutate`, and saves atomically — so a concurrent CLI/bot write
// isn't lost. Use this for every increment/merge (quota charges, recordCase);
// `mutate` receives the freshly-read ledger, not a possibly-stale in-memory copy.
export async function mutateLedger(
  path: string,
  mutate: (ledger: Ledger) => Ledger | Promise<Ledger>,
): Promise<Ledger> {
  return mutateJson<Ledger>(path, emptyLedger, async (parsed) =>
    mutate(normalize(parsed)),
  );
}
