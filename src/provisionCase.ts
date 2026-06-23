// pattern: Imperative Shell
// Operator-triggered, on-demand case provisioning — the manual precursor to the
// @-mention bot. Given a CourtListener docket id (or URL): dedupe against the
// ledger, check the CL daily quota, fetch + map the case, derive a handle, mint
// the account, point DNS at it, write the org.rcape.* records, and fire the
// backdated social backfill. --dry-run validates + prints the plan without
// creating anything (it does query CourtListener, so that spend is still
// recorded). Provisioned cases and per-case credentials land in data/ledger.json.

import { fileURLToPath } from "node:url";
import { fetchAndMapCase } from "./build.js";
import {
  type FetchCheckpoint,
  clearCachedCase,
  clearCheckpoint,
  loadCachedCase,
  loadCheckpoint,
  saveCachedCase,
  saveCheckpoint,
} from "./caseCache.js";
import { CaseRepo } from "./caseRepo.js";
import {
  CourtListenerClient,
  ThrottledError,
  parseClTokens,
} from "./courtlistener.js";
import { type DnsOptions, upsertAtprotoTxt } from "./dns.js";
import { type FireResult, fireBackfill } from "./fire.js";
import { deriveHandle } from "./handle.js";
import {
  type CaseEntry,
  type Ledger,
  RESERVED_CALLS_PER_CASE,
  chargeAndRecord,
  chargeQuota,
  findCase,
  loadLedger,
  mutateLedger,
  recordCase,
  selectToken,
  takenHandles,
} from "./ledger.js";
import { parseDocketId } from "./mention.js";
import type { NewAccount } from "./provision.js";
import { createCaseAccount, generatePassword } from "./provision.js";
import { prune } from "./repo.js";

export interface ProvisionConfig {
  // Pool of CourtListener tokens. Each has its own 125/day cap; a case runs on
  // whichever has headroom (selectToken). One token = the old single-token cap.
  tokens: string[];
  host?: string;
  domain: string;
  hashN: number;
  adminPassword: string;
  cfToken: string;
  zoneId: string;
  ledgerPath: string;
  // Directory for the fetched-case cache (see caseCache.ts). Optional so the many
  // test configs don't have to supply it; absent ⇒ caching disabled (every
  // provision re-fetches), which is the prior behavior.
  cacheDir?: string;
  // Public-directory regeneration (directorySync.ts). Both optional: the gist
  // table updates only when BOTH are set (a PropterMalone gist-scoped token +
  // the shelf gist id); absent ⇒ the directory feature is off. The combined
  // pinned post also needs gistId for its link.
  gistToken?: string;
  gistId?: string;
}

// RESERVED_CALLS_PER_CASE (the per-case upfront reservation, =10) now lives in
// ledger.ts as the atom the budget-priority ladder builds on — see imports above.
// REST-counted calls per case = 1 (docket) + ceil(entries/100) + ceil(parties/100);
// document hashing is off on storage.courtlistener.com and doesn't count, so a
// typical case is ~3 and even a large active docket rarely exceeds ~10. We charge
// it upfront as a reservation BEFORE fetching, then reconcile to the actual count —
// so a crash mid-fetch leaves the durable counter reflecting the spend already made,
// not zero (a re-run would otherwise double-spend the shared cap). The reconcile
// makes the daily total exact, and graceful 429/throttle handling catches any
// under-reservation by a rare >10-call docket cleanly (a deferred reply).

// Seams for testing without live CL / PDS / DNS / posting. All default to the
// real implementations in production.
type MakeClient = (token: string) => CourtListenerClient;
type MapCase = (
  opts: { docketId: number; token: string; hashFirstNEntries: number },
  client: CourtListenerClient,
  resume?: {
    checkpoint?: FetchCheckpoint;
    onProgress?: (cp: FetchCheckpoint) => Promise<void>;
  },
) => ReturnType<typeof fetchAndMapCase>;
type MakeAccount = (opts: {
  host?: string;
  adminPassword: string;
  handle: string;
  email: string;
  password: string;
}) => Promise<NewAccount>;
type UpsertDns = (
  handle: string,
  did: string,
  opts: DnsOptions,
) => Promise<{ created: boolean }>;
type LoginRepo = (opts: {
  host?: string;
  identifier: string;
  password: string;
}) => Promise<CaseRepo>;
type Backfill = (repo: CaseRepo) => Promise<FireResult>;

export type ProvisionResult =
  | {
      status: "provisioned";
      handle: string;
      did: string;
      caseName: string;
      // For the reply link card (card.ts). courtName is the readable label
      // (falls back to the court id when CL omits it).
      docketNumber?: string;
      courtName?: string;
      published: number;
      failed: number;
    }
  // caseName/docketNumber/courtName/filings carry the case-card facts read from
  // the existing ledger entry (absent on pre-card entries → generic card).
  | {
      status: "exists";
      handle: string;
      did: string;
      caseName?: string;
      docketNumber?: string;
      courtName?: string;
      filings?: number;
    }
  | {
      status: "dry-run";
      handle: string;
      records: number;
      entries: number;
      parties: number;
    }
  | { status: "quota-exhausted"; day: string }
  // CourtListener's hourly/daily rate window is closed mid-fetch. Distinct from a
  // fault: the case isn't broken, the limit just isn't open. retryAfterMs is the
  // server-reported cooldown so the caller can reschedule near its reopening;
  // `token` is the one that throttled, so the caller can cool down that token
  // pool-wide (a 50/hr cap is per-token) instead of re-discovering it per case.
  | { status: "throttled"; retryAfterMs: number; token: string }
  | { status: "not-found" }
  | { status: "error"; message: string };

const ENTRY_COLLECTION = "org.rcape.docketEntry";
const POST_COLLECTION = "app.bsky.feed.post";

export type ProvisionMode =
  | { kind: "fresh" }
  | { kind: "exists"; entry: CaseEntry }
  | { kind: "resume"; entry: CaseEntry }
  | { kind: "force-mint"; entry: CaseEntry };

// pattern: Functional Core
// Decide how to handle a provision request from the existing ledger entry (if
// any) and whether --force was passed. The load-bearing case is `resume`: a
// present-but-incomplete entry is a CRASH ZOMBIE — credentials were persisted
// early (so the account/password isn't orphaned) before DNS/records/backfill
// finished, then the process died. Treating its mere presence as "already
// provisioned" (the original bug) reports a handle that doesn't resolve as done;
// it must be repaired in place instead. A completed entry dedupes, or mints a
// second account under --force. The non-fresh variants carry the entry so the
// caller works with a narrowed value instead of re-asserting it's defined.
export function provisionMode(
  existing: CaseEntry | undefined,
  force: boolean,
): ProvisionMode {
  if (!existing) return { kind: "fresh" };
  if (!existing.completed) return { kind: "resume", entry: existing };
  return force
    ? { kind: "force-mint", entry: existing }
    : { kind: "exists", entry: existing };
}

// pattern: Functional Core
// The high-water sequence number is the max recapSequenceNumber among entries
// that ACTUALLY posted — i.e. excluding the rkeys fireBackfill reported as
// failed. Setting highWater to the snapshot max (ignoring failures) would let a
// future incremental monitor skip the un-posted entries forever, since it only
// fetches filings beyond highWater. recapSequenceNumber sorts lexically (it's a
// zero-padded string), matching the ordering fireBackfill uses.
export function postedHighWater(
  entries: { rkey: string; recapSequenceNumber?: string }[],
  failedRkeys: string[],
): string | undefined {
  const failed = new Set(failedRkeys);
  let max: string | undefined;
  for (const e of entries) {
    if (failed.has(e.rkey)) continue;
    const seq = e.recapSequenceNumber;
    if (seq === undefined) continue;
    if (max === undefined || seq.localeCompare(max) > 0) max = seq;
  }
  return max;
}

// Reconcile the upfront reservation to the calls actually spent: under the
// advisory lock, re-read the ledger (so a concurrent write isn't clobbered),
// then charge the delta (actual - reservation). The delta is negative when the
// case needed fewer than the reserved ~17 calls, refunding the over-reservation.
// quotaRemaining clamps at zero, so a net under-count is harmless.
//
// Also append the ACTUAL calls to the rolling 24h log (recordCalls): the calendar
// counter resets at 8pm ET but CL's rolling windows don't, so the log is what lets
// the next selectToken predict a 429 instead of eating one (2026-06-16 freeze).
async function reconcileQuota(
  ledgerPath: string,
  actualCalls: number,
  day: string,
  token: string,
): Promise<Ledger> {
  const nowMs = Date.now();
  return mutateLedger(ledgerPath, (fresh) =>
    chargeAndRecord(
      fresh,
      actualCalls,
      day,
      token,
      nowMs,
      RESERVED_CALLS_PER_CASE,
    ),
  );
}

// Wipe a half-provisioned repo back to a clean slate before re-applying records
// and re-firing the backfill on a RESUME. applyWrites#create on an already-
// present rkey is rejected by the PDS (implementation behavior — the lexicon
// documents only InvalidSwap), and fireBackfill refuses when any post exists, so
// a crash mid-write would otherwise leave the account un-reprovisionable in
// place. Deleting the rcape record collections + all posts first (the profile is
// overwritten by the backfill, not deleted) sidesteps both and makes the rebuild
// idempotent. (putRecord is create-or-update, but applyWrites batches.)
async function resetRepo(
  repo: CaseRepo,
  rows: { collection: string }[],
): Promise<void> {
  const collections = new Set(rows.map((r) => r.collection));
  collections.add(POST_COLLECTION);
  for (const collection of collections) {
    const existing = await repo.collect(collection);
    if (existing.length > 0) {
      await repo.applyDeletes(
        existing.map((r) => ({ collection, rkey: r.rkey })),
      );
    }
  }
}

// Provision a case end-to-end, in-process. Callable by both the operator CLI
// (main, below) and the @-mention bot. Handles four modes (see provisionMode):
// dedupe a completed case, RESUME a crash zombie in place, mint fresh, or mint a
// second account under --force. Returns a discriminated result the caller maps
// to output/replies.
export async function runProvision(
  docketId: number,
  cfg: ProvisionConfig,
  opts: {
    force?: boolean;
    dryRun?: boolean;
    makeClient?: MakeClient;
    mapCase?: MapCase;
    makeAccount?: MakeAccount;
    upsertDns?: UpsertDns;
    loginRepo?: LoginRepo;
    backfill?: Backfill;
  } = {},
): Promise<ProvisionResult> {
  const makeAccount = opts.makeAccount ?? createCaseAccount;
  const upsertDns = opts.upsertDns ?? upsertAtprotoTxt;
  const loginRepo = opts.loginRepo ?? ((o) => CaseRepo.login(o));
  const backfill = opts.backfill ?? ((repo) => fireBackfill(repo));

  let ledger = await loadLedger(cfg.ledgerPath);
  const existing = findCase(ledger, docketId);
  const mode = provisionMode(existing, opts.force ?? false);

  if (mode.kind === "exists") {
    return {
      status: "exists",
      handle: mode.entry.handle,
      did: mode.entry.did,
      caseName: mode.entry.caseName,
      docketNumber: mode.entry.docketNumber,
      courtName: mode.entry.courtName,
      filings: mode.entry.filings,
    };
  }

  const day = new Date().toISOString().slice(0, 10);
  const nowIso = new Date().toISOString();

  // Reuse a prior fetch for this docket when one is cached and fresh: a retry or
  // operator restart then pays ZERO CL calls instead of re-fetching + re-hashing
  // the whole docket (the re-thrash that spent a day's quota on no provisions,
  // 2026-06-16). A cache hit needs neither a token nor a quota charge — we make
  // no CL request at all.
  let mapped: Awaited<ReturnType<typeof fetchAndMapCase>> | undefined =
    cfg.cacheDir
      ? await loadCachedCase(cfg.cacheDir, docketId, Date.parse(nowIso))
      : undefined;

  if (!mapped) {
    // Pick a token from the pool with room for a whole case. nowMs engages the
    // predictive rolling-window gate (the point of the rolling ledger): a token
    // whose 24h/hourly window is full is skipped here too, not just at the drain
    // gate — without it the second independent selection re-introduces the 429 the
    // moment the pool holds more than one token. None → no token has both daily
    // budget AND an open rolling window.
    const token = selectToken(
      ledger,
      cfg.tokens,
      day,
      RESERVED_CALLS_PER_CASE,
      Date.now(),
    );
    if (!token) {
      return { status: "quota-exhausted", day };
    }

    const client = (opts.makeClient ?? ((t) => new CourtListenerClient(t)))(
      token,
    );
    const mapCase = opts.mapCase ?? fetchAndMapCase;

    // Resume a fetch interrupted by an earlier window's throttle: the checkpoint
    // holds the pages already fetched + the cursor to continue from, so a big
    // docket advances each window instead of restarting at page 1 (the head-of-
    // line freeze of 2026-06-17). onProgress checkpoints after every page, so the
    // ThrottledError below propagates with durable progress already saved.
    const checkpoint = cfg.cacheDir
      ? await loadCheckpoint(cfg.cacheDir, docketId, Date.parse(nowIso))
      : undefined;
    const resume = cfg.cacheDir
      ? {
          checkpoint,
          onProgress: (cp: FetchCheckpoint) =>
            saveCheckpoint(
              cfg.cacheDir as string,
              docketId,
              cp,
              new Date().toISOString(),
            ),
        }
      : undefined;

    // Reserve the expected spend BEFORE the fetch and persist it, so a crash
    // during pagination can't lose the calls already made to CL. Charged against
    // the SELECTED token under the lock on a freshly-read ledger so a concurrent
    // CLI/bot quota write isn't clobbered; reconciled to the real count below.
    // With resume, this is a per-WINDOW reservation (each window charges only the
    // pages it fetches to whichever token ran it; the cursor carries no token).
    ledger = await mutateLedger(cfg.ledgerPath, (fresh) =>
      chargeQuota(fresh, RESERVED_CALLS_PER_CASE, day, token),
    );

    try {
      mapped = await mapCase(
        { docketId, token, hashFirstNEntries: cfg.hashN },
        client,
        resume,
      );
    } catch (e) {
      // Reconcile the reservation to the calls actually spent, then classify.
      ledger = await reconcileQuota(
        cfg.ledgerPath,
        client.requestCount,
        day,
        token,
      );
      if (e instanceof ThrottledError) {
        // Checkpoint already persisted by onProgress — the next window resumes.
        return { status: "throttled", retryAfterMs: e.retryAfterMs, token };
      }
      const msg = e instanceof Error ? e.message : String(e);
      if (/CourtListener 404/.test(msg)) {
        // Vanished docket — drop its checkpoint so it doesn't linger to TTL.
        if (cfg.cacheDir) await clearCheckpoint(cfg.cacheDir, docketId);
        return { status: "not-found" };
      }
      return { status: "error", message: msg };
    }
    ledger = await reconcileQuota(
      cfg.ledgerPath,
      client.requestCount,
      day,
      token,
    );

    // Persist the successful fetch BEFORE the PDS/DNS/backfill work below (which
    // can still throw and bounce the job to a retry). The retry then reuses this
    // instead of re-spending CL quota on a docket we already have. Clear the
    // partial checkpoint AFTER the complete cache is durable (a crash between is
    // harmless — the checkpoint just re-resumes into the now-present cache).
    if (cfg.cacheDir) {
      await saveCachedCase(cfg.cacheDir, docketId, mapped, nowIso);
      await clearCheckpoint(cfg.cacheDir, docketId);
    }
  }

  // A resume reuses the stored handle; minting fresh derives a new one that
  // avoids every spoken-for handle (live + superseded).
  const handle =
    mode.kind === "resume"
      ? mode.entry.handle
      : deriveHandle(
          mapped.docketRecord.caseName,
          mapped.docketRecord.docketNumber,
          cfg.domain,
          takenHandles(ledger),
        );
  const rcapeRecords = mapped.records.map((r) => ({
    collection: r.collection,
    rkey: r.rkey,
    value: prune(r.record),
  }));

  if (opts.dryRun) {
    return {
      status: "dry-run",
      handle,
      records: rcapeRecords.length,
      entries: mapped.entryRecords.length,
      parties: mapped.parties.length,
    };
  }

  // Everything past the CL fetch hits the PDS/Cloudflare — external systems the
  // drain's retry+backoff exists to absorb. Without this guard a throw here ("Handle
  // too long", a PDS 5xx, a DNS hiccup) escapes drain entirely, leaving the job
  // queued so it re-provisions every poll — bypassing MAX_PROVISION_RETRIES and
  // re-spending CL quota. Return an error so it flows through the retry cap instead.
  try {
    // Establish the account + an authenticated repo per mode. createdAt is the
    // ledger entry's original timestamp on a resume, fresh otherwise.
    let account: NewAccount;
    let repo: CaseRepo;
    let createdAt: string;
    if (mode.kind === "resume") {
      const zombie = mode.entry;
      // A wide-window zombie always carries a did (early-persist wrote it before
      // the crash window). The deferred micro-window — a crash during mint, before
      // early-persist — produces NO ledger entry, so it never reaches resume. Guard
      // anyway rather than attempt a PDS login with an empty identifier if a future
      // change ever persists a did-less entry.
      if (!zombie.did) {
        return {
          status: "error",
          message: `cannot resume docket ${docketId}: ledger entry has no DID (manual recovery required)`,
        };
      }
      account = {
        did: zombie.did,
        handle: zombie.handle,
        password: zombie.password,
      };
      createdAt = zombie.createdAt;
      repo = await loginRepo({
        host: cfg.host,
        identifier: account.did,
        password: account.password,
      });
      // The repo may hold a partial write from the crashed run — clear it so the
      // record re-apply and backfill below are idempotent.
      await resetRepo(repo, rcapeRecords);
    } else {
      if (mode.kind === "force-mint") {
        console.warn(
          `WARNING: docket ${docketId} is already provisioned at @${mode.entry.handle}; --force mints a SECOND account (the prior one is archived in the ledger, not deleted from the PDS).`,
        );
      }
      const password = generatePassword();
      createdAt = new Date().toISOString();
      console.log(`  creating account @${handle}…`);
      account = await makeAccount({
        host: cfg.host,
        adminPassword: cfg.adminPassword,
        handle,
        email: `case-${docketId}@${cfg.domain}`,
        password,
      });
      // Persist credentials immediately — before DNS/records/backfill — so a crash
      // orphans neither the account nor its (only-stored) password, and a re-run
      // resumes this entry instead of minting a duplicate. No `completed` flag yet:
      // that's the signal the work below still has to finish.
      ledger = await mutateLedger(cfg.ledgerPath, (fresh) =>
        recordCase(fresh, docketId, {
          did: account.did,
          handle: account.handle,
          password,
          createdAt,
        }),
      );
      repo = await loginRepo({
        host: cfg.host,
        identifier: account.did,
        password,
      });
    }

    // DNS is idempotent (upsert), so it runs for both fresh and resume — a zombie
    // may have crashed before its TXT was written.
    await upsertDns(account.handle, account.did, {
      zoneId: cfg.zoneId,
      token: cfg.cfToken,
    });

    // Entries must be written before the backfill — it reads them back via
    // listAll(ENTRY) and silently posts nothing if they're absent.
    await repo.applyCreates(rcapeRecords);
    const result = await backfill(repo);

    // highWater must cap at the max recapSequenceNumber actually POSTED, not the
    // snapshot max: result.failed holds the entry rkeys whose backdated doc-post
    // failed, and advancing highWater past them would make the future incremental
    // monitor (which only fetches filings beyond highWater) skip them forever.
    // Correlate failed rkeys to sequence numbers via rcapeRecords (rkey + value).
    const entrySeqs = rcapeRecords
      .filter((r) => r.collection === ENTRY_COLLECTION)
      .map((r) => ({
        rkey: r.rkey,
        recapSequenceNumber: (r.value as { recapSequenceNumber?: string })
          .recapSequenceNumber,
      }));
    // Terminal write: this is the ONLY place `completed` is set — it marks the
    // case fully provisioned so a future re-run dedupes instead of resuming.
    const courtName =
      mapped.docketRecord.courtName ?? mapped.docketRecord.court;
    ledger = await mutateLedger(cfg.ledgerPath, (fresh) =>
      recordCase(fresh, docketId, {
        did: account.did,
        handle: account.handle,
        password: account.password,
        createdAt,
        completed: true,
        highWater: postedHighWater(entrySeqs, result.failed),
        backfillFailed: result.failed.length > 0 ? result.failed : undefined,
        // Card facts for the dedupe reply later (see CaseEntry / card.ts).
        caseName: mapped.docketRecord.caseName,
        docketNumber: mapped.docketRecord.docketNumber,
        courtName,
        filings: result.published,
      }),
    );

    // Terminally complete → the cache will never be read again (the dedupe
    // short-circuits on `completed`), so drop it to bound data/case-cache growth.
    // Best-effort, AFTER the completed write is durable: a crash between leaves a
    // harmless orphan the next run won't read. Sibling of clearCheckpoint above.
    if (cfg.cacheDir) await clearCachedCase(cfg.cacheDir, docketId);

    return {
      status: "provisioned",
      handle: account.handle,
      did: account.did,
      caseName: mapped.docketRecord.caseName,
      docketNumber: mapped.docketRecord.docketNumber,
      courtName,
      published: result.published,
      failed: result.failed.length,
    };
  } catch (e) {
    return {
      status: "error",
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not set`);
  return v;
}

function ledgerPath(): string {
  return fileURLToPath(new URL("../data/ledger.json", import.meta.url));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const force = argv.includes("--force");
  const docketId = parseDocketId(argv.find((a) => !a.startsWith("--")));
  if (docketId === null) {
    throw new Error(
      "usage: provision <courtlistener-docket-id | docket-url> [--dry-run] [--force]",
    );
  }

  const cfg: ProvisionConfig = {
    tokens: parseClTokens(),
    host: process.env.PDS_HOSTNAME,
    domain: process.env.RCAPE_HANDLE_DOMAIN ?? "rcape.org",
    hashN: Number(process.env.RCAPE_HASH_FIRST_N ?? "15"),
    // Live-only secrets; not needed for a dry run.
    adminPassword: dryRun ? "" : requireEnv("PDS_ADMIN_PASSWORD"),
    cfToken: dryRun ? "" : requireEnv("CLOUDFLARE_API_TOKEN"),
    zoneId: dryRun ? "" : requireEnv("CLOUDFLARE_ZONE_ID"),
    ledgerPath: ledgerPath(),
    cacheDir: fileURLToPath(new URL("../data/case-cache", import.meta.url)),
  };

  console.log(`Provisioning docket ${docketId}…`);
  const result = await runProvision(docketId, cfg, { force, dryRun });
  switch (result.status) {
    case "exists":
      console.log(
        `already provisioned: docket ${docketId} -> @${result.handle} (${result.did}). Pass --force to mint a fresh account.`,
      );
      break;
    case "quota-exhausted":
      console.error(
        `CourtListener daily quota exhausted (${result.day}); try again tomorrow.`,
      );
      process.exitCode = 1;
      break;
    case "not-found":
      console.error(`docket ${docketId} not found on CourtListener.`);
      process.exitCode = 1;
      break;
    case "dry-run":
      console.log(
        `[dry-run] @${result.handle} — ${result.records} records (${result.entries} entries, ${result.parties} parties); no account, no DNS, no posts written.`,
      );
      break;
    case "provisioned":
      console.log(
        `done — @${result.handle} provisioned (${result.published} posts published, ${result.failed} failed).`,
      );
      break;
    case "error":
      console.error(result.message);
      process.exitCode = 1;
      break;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
