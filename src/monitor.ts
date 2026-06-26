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
import { type FireResult, type LiveEntry, postEntries } from "./fire.js";
import {
  type CaseEntry,
  type Ledger,
  MIN_QUOTA_FOR_CASE,
  chargeAndRecord,
  chargeQuota,
  loadLedger,
  mutateLedger,
  recordCase,
  selectToken,
} from "./ledger.js";
import type { DocketEntryRecord } from "./map.js";
import { makeSource, mapDocket, mapEntry } from "./map.js";
import { type ProvisionConfig, postedHighWater } from "./provisionCase.js";
import { nextRkey, prune } from "./repo.js";

const ENTRY_COLLECTION = "org.rcape.docketEntry";
const DOCKET_COLLECTION = "org.rcape.docket";

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
// The monitor proceeds only if a token has budget BEYOND this provisioning floor.
// It shares the by-request rung (MIN_QUOTA_FOR_CASE, the centralized ladder top in
// ledger.ts) — monitoring must never starve a live request. See imports above.
const MONITOR_PROVISION_FLOOR = MIN_QUOTA_FOR_CASE;

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
  // them to the rolling 24h log in one atomic step (chargeAndRecord) — same dual
  // accounting as runProvision's reconcileQuota, so the next selectToken predicts
  // CL's rolling windows instead of eating a 429.
  const reconcileMonitor = (tok: string, calls: number) =>
    mutateLedger(cfg.ledgerPath, (l) =>
      chargeAndRecord(l, calls, day, tok, Date.now(), MONITOR_RESERVED_CALLS),
    );
  for (const { docketId, entry } of due) {
    // Repair any backfillFailed companion posts FIRST and unconditionally — it's
    // quota-free (PDS reads/writes only, no CL call) and best-effort, so it must
    // run even when this case's CL budget is exhausted (the `break` below would
    // otherwise skip it). Cadence-gated by selectDueCases like the rest of the pass.
    await repairCase(cfg, docketId, entry, loginRepo);

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

    // The PDS login + post block: an auth failure here can throw an error whose
    // message echoes the case credentials. Mirror the drain's guard (bot.ts) — log
    // ONLY docketId + the error type/status, never e.message, since journald retains
    // it. An uncaught throw would also exit the whole loop and bubble to pollOnce,
    // which logs e.message; the try/catch keeps the failure local and quiet.
    let result: FireResult;
    try {
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
      result = await postEntries(repo, liveEntries, caseName, caseUrl);
    } catch (e) {
      // status (not message): an Atproto/XRPC error carries a `.status`; fall back
      // to the error constructor name — both are credential-free.
      const status =
        (e as { status?: number })?.status ??
        (e instanceof Error ? e.name : "unknown");
      console.error(
        `monitor: docket ${docketId} login/post failed (${status})`,
      );
      // Leave highWater untouched so the new filings retry next cadence; stamp
      // checked so a persistent auth fault doesn't re-hammer every cadence.
      await stampChecked(cfg.ledgerPath, docketId, nowIso);
      checked += 1;
      continue;
    }

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

// Re-create the companion doc-posts for a case's backfillFailed rkeys — entries
// whose RECORD exists (applyCreates wrote it before the post failed) but which
// never got a backdated app.bsky.feed.post. QUOTA-FREE: the records already live
// in the case's own repo, so repair reads them back (PDS reads) and re-runs
// postEntries (PDS writes) — it makes NO CourtListener call and charges no quota.
//
// Duplicate guard: a docketEntry whose `docPost` strongRef is already set was in
// fact posted — its rkey is just STALE in backfillFailed (a crash after the post
// but before the ledger prune). Those are pruned WITHOUT re-posting, since
// postEntries always creates a NEW post (it can't dedupe) and a duplicate filing
// post is worse than a stale list entry. Only records that genuinely lack a
// docPost are re-posted.
//
// Returns the rkeys that are now safe to drop from backfillFailed (re-posted OK
// OR already had a docPost) so the caller prunes only those — an rkey that fails
// AGAIN stays in the list for the next cadence. Best-effort by contract: a thrown
// fault here is caught by the caller and never aborts the monitor pass.
async function repairBackfill(
  repo: CaseRepo,
  rkeys: string[],
): Promise<{ repaired: string[]; posted: number }> {
  // Read each entry record back; correlate the failed rkey to its current value
  // so we can both build the postEntries shape and inspect its docPost field.
  const toPost: LiveEntry[] = [];
  const alreadyPosted: string[] = [];
  for (const rkey of rkeys) {
    let value: DocketEntryRecord;
    try {
      value = (await repo.getRecord(
        ENTRY_COLLECTION,
        rkey,
      )) as unknown as DocketEntryRecord;
    } catch {
      // The record is genuinely gone (e.g. a takedown removed the entry) — drop
      // the rkey so it stops being a perpetual repair target. Nothing to post.
      alreadyPosted.push(rkey);
      continue;
    }
    if (value.docPost) {
      // Stale in the list: the post exists. Prune without re-posting.
      alreadyPosted.push(rkey);
    } else {
      toPost.push({ rkey, value });
    }
  }

  if (toPost.length === 0) return { repaired: alreadyPosted, posted: 0 };

  // Derive caseName / caseUrl from the case's own docket record — another PDS
  // read, no CL call. Mirrors fireBackfill's loadDocket, kept local so repair
  // never reaches for the network.
  const docket = (await repo.getRecord(
    DOCKET_COLLECTION,
    "self",
  )) as unknown as {
    caseName?: string;
    source?: { url?: string };
  };
  const caseName = docket.caseName ?? "this case";
  const caseUrl = docket.source?.url ?? "https://www.courtlistener.com/";

  const result = await postEntries(repo, toPost, caseName, caseUrl);
  const failed = new Set(result.failed);
  // Re-posted OK = the toPost rkeys minus those that failed again; combine with
  // the stale-but-already-posted set. Only these are pruned from backfillFailed.
  const reposted = toPost.map((e) => e.rkey).filter((r) => !failed.has(r));
  return {
    repaired: [...alreadyPosted, ...reposted],
    posted: result.published,
  };
}

// Best-effort backfill-repair for one due case: if its ledger entry carries
// unrepaired rkeys, log into the repo, re-create the missing companion posts, and
// prune the repaired rkeys (bumping the public filing count by the number actually
// re-posted). Quota-free (PDS only). A repair failure is swallowed here so it can
// never abort the monitor pass — the rkeys simply stay for the next cadence.
async function repairCase(
  cfg: ProvisionConfig,
  docketId: number,
  entry: CaseEntry,
  loginRepo: NonNullable<MonitorSeams["loginRepo"]>,
): Promise<void> {
  const rkeys = entry.backfillFailed ?? [];
  if (rkeys.length === 0) return;
  try {
    const repo = await loginRepo({
      host: cfg.host,
      identifier: entry.did,
      password: entry.password,
    });
    const { repaired, posted } = await repairBackfill(repo, rkeys);
    if (repaired.length === 0) return;
    const drop = new Set(repaired);
    await mutateLedger(cfg.ledgerPath, (l) => {
      // Prune under the lock against the FRESH list (the drain/monitor may have
      // appended new failures since we read) — keep only rkeys NOT repaired this
      // pass, preserving UNION semantics with anything added concurrently. recordCase
      // merges field-wise, so the password/superseded/highWater fields are untouched.
      const priorCase = l.cases[String(docketId)];
      const prior = priorCase?.backfillFailed ?? [];
      const remaining = prior.filter((r) => !drop.has(r));
      const filings = (priorCase?.filings ?? 0) + posted;
      return recordCase(l, docketId, {
        // Drop the key entirely when nothing's left, so the entry doesn't carry an
        // empty array forever (matches how provision/monitor omit it when empty).
        backfillFailed: remaining.length ? remaining : undefined,
        filings,
      } as CaseEntry);
    });
    console.log(
      `monitor: docket ${docketId} (@${entry.handle}) repaired ${posted} backfill post(s), ${rkeys.length - drop.size} still failing`,
    );
  } catch (e) {
    // status (not message): an Atproto/XRPC error may echo the case credentials.
    const status =
      (e as { status?: number })?.status ??
      (e instanceof Error ? e.name : "unknown");
    console.error(
      `monitor: docket ${docketId} backfill repair failed (${status})`,
    );
  }
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
