// pattern: Imperative Shell
// Watched-case auto-monitor — makes "follow for new filings" true. Provisioned
// dockets were frozen snapshots; once per cadence this re-checks each completed
// case for filings beyond its high-water mark and appends them (records +
// backdated companion posts), so following a case account surfaces new filings.
//
// Runs IN-PROCESS in the poll loop (single writer — the JSON state layer assumes
// one). Self-gated by cadence + budget, so most cycles are cheap no-ops. The
// incremental fetch (fetchDocketEntriesSince, DESC + early-stop) pays ~1 CL call
// when a docket has nothing new — essential under CourtListener's rate limit.

import { CaseRepo } from "./caseRepo.js";
import { CourtListenerClient, ThrottledError } from "./courtlistener.js";
import type { ClDocketEntry } from "./courtlistener.types.js";
import { type FireResult, postEntries } from "./fire.js";
import {
  type CaseEntry,
  type Ledger,
  chargeQuota,
  loadLedger,
  mutateLedger,
  recordCalls,
  recordCase,
  selectToken,
} from "./ledger.js";
import { makeSource, mapDocket, mapEntry } from "./map.js";
import { type ProvisionConfig, postedHighWater } from "./provisionCase.js";
import { nextRkey, prune } from "./repo.js";

const ENTRY_COLLECTION = "org.rcape.docketEntry";

// How long a completed case rests before it's re-checked. Conservative by default
// (a federal docket rarely gains filings hourly) to bound the per-case CL spend as
// the archive grows — each watched case costs ~1 call/cadence when nothing's new.
const MONITOR_INTERVAL_MS = Number(
  process.env.RCAPE_MONITOR_INTERVAL_MS ?? 3 * 24 * 60 * 60 * 1000,
);
// At most this many cases checked per poll cycle, so one cycle can't blow the
// budget; the rest roll to later cycles (oldest-checked first).
const MONITOR_MAX_PER_CYCLE = Number(
  process.env.RCAPE_MONITOR_MAX_PER_CYCLE ?? 3,
);
// Per-case reservation for the monitor's own CL calls (fetchSince + maybe a
// getDocket + slack), reconciled to the real count after.
const MONITOR_RESERVED_CALLS = 5;
// The monitor proceeds only if a token has budget BEYOND this provisioning floor
// (mirrors bot.MIN_QUOTA_FOR_CASE) — monitoring must never starve a live request.
const MONITOR_PROVISION_FLOOR = 12;

export interface MonitorDeps {
  cfg: ProvisionConfig;
}

export interface MonitorSeams {
  makeClient?: (token: string) => CourtListenerClient;
  loginRepo?: (opts: {
    host?: string;
    identifier: string;
    password: string;
  }) => Promise<CaseRepo>;
  now?: () => number;
}

export interface DueCase {
  docketId: number;
  entry: CaseEntry;
}

// pattern: Functional Core
// Completed cases due for a re-check: have a handle + high-water, and were last
// checked (or, if never, provisioned) longer ago than the interval. Oldest-first
// so attention round-robins; capped per cycle. A freshly-provisioned case falls
// back to createdAt, so it isn't re-checked until a full interval has passed.
export function selectDueCases(
  ledger: Ledger,
  nowMs: number,
  intervalMs: number,
  max: number,
): DueCase[] {
  return Object.entries(ledger.cases)
    .filter(([, c]) => c.completed && c.handle && c.highWater)
    .map(([id, c]) => ({
      docketId: Number(id),
      entry: c,
      lastMs: Date.parse(c.lastCheckedAt ?? c.createdAt ?? "") || 0,
    }))
    .filter((d) => nowMs - d.lastMs >= intervalMs)
    .sort((a, b) => a.lastMs - b.lastMs)
    .slice(0, max)
    .map(({ docketId, entry }) => ({ docketId, entry }));
}

// One monitor pass: re-check due cases for new filings and append them. Called
// from pollOnce after drain. Returns the count of cases that gained filings.
export async function monitorOnce(
  deps: MonitorDeps,
  seams: MonitorSeams = {},
): Promise<{ checked: number; updated: number }> {
  const now = seams.now ?? Date.now;
  const nowMs = now();
  const nowIso = new Date(nowMs).toISOString();
  const day = nowIso.slice(0, 10);
  const cfg = deps.cfg;

  const ledger = await loadLedger(cfg.ledgerPath);
  const due = selectDueCases(
    ledger,
    nowMs,
    MONITOR_INTERVAL_MS,
    MONITOR_MAX_PER_CYCLE,
  );
  if (due.length === 0) return { checked: 0, updated: 0 };

  const makeClient =
    seams.makeClient ?? ((t: string) => new CourtListenerClient(t));
  const loginRepo = seams.loginRepo ?? ((o) => CaseRepo.login(o));

  let checked = 0;
  let updated = 0;
  // Reconcile the monitor's reservation to the calls actually spent AND append
  // them to the rolling 24h log (recordCalls) — same dual accounting as
  // runProvision's reconcileQuota, so the next selectToken predicts CL's rolling
  // windows instead of eating a 429.
  const reconcileMonitor = (tok: string, calls: number) =>
    mutateLedger(cfg.ledgerPath, (l) =>
      recordCalls(
        chargeQuota(l, calls - MONITOR_RESERVED_CALLS, day, tok),
        tok,
        Date.now(),
        calls,
      ),
    );
  for (const { docketId, entry } of due) {
    // Budget gate per case (re-read for live quota): only proceed with headroom
    // BEYOND a full provisioning case, so monitoring never starves a live request.
    const fresh = await loadLedger(cfg.ledgerPath);
    const token = selectToken(
      fresh,
      cfg.tokens,
      day,
      MONITOR_PROVISION_FLOOR + MONITOR_RESERVED_CALLS,
      nowMs,
    );
    if (!token) break; // out of monitor budget — the rest roll to a later cycle

    const client = makeClient(token);
    // Reserve before the fetch (crash-safe, like runProvision), reconcile after.
    await mutateLedger(cfg.ledgerPath, (l) =>
      chargeQuota(l, MONITOR_RESERVED_CALLS, day, token),
    );

    let newRaw: ClDocketEntry[];
    try {
      // entry.highWater is guaranteed by selectDueCases.
      newRaw = await client.fetchDocketEntriesSince(
        docketId,
        entry.highWater as string,
      );
    } catch (e) {
      await reconcileMonitor(token, client.requestCount);
      if (e instanceof ThrottledError) break; // window closed — stop this cycle
      console.error(
        `monitor: docket ${docketId} entry fetch failed:`,
        e instanceof Error ? e.message : String(e),
      );
      // Stamp checked so a persistent fault doesn't get re-hammered every cadence.
      await stampChecked(cfg.ledgerPath, docketId, nowIso);
      checked += 1;
      continue;
    }

    if (newRaw.length === 0) {
      await reconcileMonitor(token, client.requestCount);
      await stampChecked(cfg.ledgerPath, docketId, nowIso);
      checked += 1;
      continue;
    }

    // New filings exist — fetch the docket once for caseName/source/URL, then map.
    let docket: Awaited<ReturnType<CourtListenerClient["getDocket"]>>;
    try {
      docket = await client.getDocket(docketId);
    } catch (e) {
      await reconcileMonitor(token, client.requestCount);
      if (e instanceof ThrottledError) break;
      console.error(
        `monitor: docket ${docketId} getDocket failed:`,
        e instanceof Error ? e.message : String(e),
      );
      // Stamp checked (like the entry-fetch fault path) so a persistently-faulting
      // getDocket doesn't get re-checked + re-charged every cadence. highWater is
      // untouched, so the new filings are picked up on the next cadence's retry.
      await stampChecked(cfg.ledgerPath, docketId, nowIso);
      checked += 1;
      continue;
    }
    await reconcileMonitor(token, client.requestCount);

    const source = makeSource(docket, nowIso);
    const caseName = mapDocket(docket, nowIso, nowIso).caseName;
    const caseUrl = source.url ?? "https://www.courtlistener.com/";
    // newRaw is newest-first; post oldest-first so the backdated timeline reads in
    // filing order.
    const liveEntries = [...newRaw].reverse().map((e) => ({
      rkey: nextRkey(),
      value: prune(mapEntry(e, source, nowIso)),
    }));

    const repo = await loginRepo({
      host: cfg.host,
      identifier: entry.did,
      password: entry.password,
    });
    await repo.applyCreates(
      liveEntries.map((e) => ({
        collection: ENTRY_COLLECTION,
        rkey: e.rkey,
        value: e.value as unknown as Record<string, unknown>,
      })),
    );
    const result: FireResult = await postEntries(
      repo,
      liveEntries,
      caseName,
      caseUrl,
    );

    // Advance high-water to the newest entry actually POSTED (failed ones stay
    // below the line so they're retried next cadence) and stamp the check time.
    const newHigh = postedHighWater(
      liveEntries.map((e) => ({
        rkey: e.rkey,
        recapSequenceNumber: e.value.recapSequenceNumber,
      })),
      result.failed,
    );
    await mutateLedger(cfg.ledgerPath, (l) => {
      // UNION this pass's failed rkeys with any the original provision left
      // unrepaired (read fresh inside the lock) — recordCase merges field-wise, so
      // a bare assignment would silently drop the provision-time repair targets.
      const priorCase = l.cases[String(docketId)];
      const prior = priorCase?.backfillFailed ?? [];
      const failed = [...new Set([...prior, ...result.failed])];
      // Bump the public filing count so the directory gist's "Filings" column
      // reflects the just-posted filings (this regen, fired on updated > 0, would
      // otherwise re-publish the stale provision-time count). Read prior under the
      // lock, like backfillFailed.
      const filings = (priorCase?.filings ?? 0) + result.published;
      return recordCase(l, docketId, {
        ...(newHigh ? { highWater: newHigh } : {}),
        ...(failed.length ? { backfillFailed: failed } : {}),
        filings,
        lastCheckedAt: nowIso,
      } as CaseEntry);
    });
    console.log(
      `monitor: docket ${docketId} (@${entry.handle}) +${result.published} new filing(s), ${result.failed.length} failed`,
    );
    checked += 1;
    if (result.published > 0) updated += 1;
  }
  return { checked, updated };
}

// Stamp only lastCheckedAt (a partial merge — recordCase preserves every other
// field, notably the irreplaceable password and the unchanged highWater).
function stampChecked(
  ledgerPath: string,
  docketId: number,
  nowIso: string,
): Promise<Ledger> {
  return mutateLedger(ledgerPath, (l) =>
    recordCase(l, docketId, { lastCheckedAt: nowIso } as CaseEntry),
  );
}
