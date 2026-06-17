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
}

// CourtListener free tier: 125 requests/day per token.
export const DAILY_CAP = 125;

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

// Pick the first configured token with at least `need` requests left today AND
// not in a hourly-throttle cooldown, or undefined when none qualifies. A single
// case must run end-to-end on ONE token (CL pagination carries the token), so
// headroom can't be pooled across tokens — we need one token that can cover the
// whole case. Pass `nowMs` to honor the throttle cooldown; omit it (legacy
// callers/tests that don't model throttling) to consider quota only.
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
      (nowMs === undefined || !isThrottled(ledger, t, nowMs)),
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
