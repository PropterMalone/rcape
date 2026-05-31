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
import { CaseRepo } from "./caseRepo.js";
import { CourtListenerClient } from "./courtlistener.js";
import { upsertAtprotoTxt } from "./dns.js";
import { fireBackfill } from "./fire.js";
import { deriveHandle } from "./handle.js";
import {
  type Ledger,
  chargeQuota,
  findCase,
  loadLedger,
  mutateLedger,
  quotaRemaining,
  recordCase,
} from "./ledger.js";
import { parseDocketId } from "./mention.js";
import { createCaseAccount, generatePassword } from "./provision.js";
import { prune } from "./repo.js";

export interface ProvisionConfig {
  token: string;
  host?: string;
  domain: string;
  hashN: number;
  adminPassword: string;
  cfToken: string;
  zoneId: string;
  ledgerPath: string;
}

// A full case fetch is ~17 CL calls (docket + entry pages + party pages). We
// charge this upfront as a reservation BEFORE fetching, then reconcile to the
// actual count on completion — so a crash mid-fetch leaves the durable counter
// reflecting the spend already made to CourtListener, not zero. Without this, a
// crash loses every counted call and the re-run double-spends the shared cap.
const RESERVED_CALLS_PER_CASE = 17;

// Seams for testing the crash-mid-fetch path without a live CL call. Both
// default to the real implementations in production.
type MakeClient = (token: string) => CourtListenerClient;
type MapCase = (
  opts: { docketId: number; token: string; hashFirstNEntries: number },
  client: CourtListenerClient,
) => ReturnType<typeof fetchAndMapCase>;

export type ProvisionResult =
  | {
      status: "provisioned";
      handle: string;
      did: string;
      caseName: string;
      published: number;
      failed: number;
    }
  | { status: "exists"; handle: string; did: string }
  | {
      status: "dry-run";
      handle: string;
      records: number;
      entries: number;
      parties: number;
    }
  | { status: "quota-exhausted"; day: string }
  | { status: "not-found" }
  | { status: "error"; message: string };

// Reconcile the upfront reservation to the calls actually spent: under the
// advisory lock, re-read the ledger (so a concurrent write isn't clobbered),
// then charge the delta (actual - reservation). The delta is negative when the
// case needed fewer than the reserved ~17 calls, refunding the over-reservation.
// quotaRemaining clamps at zero, so a net under-count is harmless.
async function reconcileQuota(
  ledgerPath: string,
  actualCalls: number,
  day: string,
): Promise<Ledger> {
  return mutateLedger(ledgerPath, (fresh) =>
    chargeQuota(fresh, actualCalls - RESERVED_CALLS_PER_CASE, day),
  );
}

// Provision a case end-to-end, in-process. Callable by both the operator CLI
// (main, below) and the @-mention bot. Reuses the early-persist + archive +
// quota logic; returns a discriminated result the caller maps to output/replies.
export async function runProvision(
  docketId: number,
  cfg: ProvisionConfig,
  opts: {
    force?: boolean;
    dryRun?: boolean;
    makeClient?: MakeClient;
    mapCase?: MapCase;
  } = {},
): Promise<ProvisionResult> {
  let ledger = await loadLedger(cfg.ledgerPath);

  const existing = findCase(ledger, docketId);
  if (existing && !opts.force) {
    return { status: "exists", handle: existing.handle, did: existing.did };
  }

  const day = new Date().toISOString().slice(0, 10);
  if (quotaRemaining(ledger, day) <= 0) {
    return { status: "quota-exhausted", day };
  }

  const client = (opts.makeClient ?? ((t) => new CourtListenerClient(t)))(
    cfg.token,
  );
  const mapCase = opts.mapCase ?? fetchAndMapCase;

  // Reserve the expected spend BEFORE the fetch and persist it, so a crash
  // during pagination can't lose the calls already made to CL. Charged under the
  // lock against a freshly-read ledger so a concurrent CLI/bot quota write isn't
  // clobbered; reconciled to the real requestCount below.
  ledger = await mutateLedger(cfg.ledgerPath, (fresh) =>
    chargeQuota(fresh, RESERVED_CALLS_PER_CASE, day),
  );

  let mapped: Awaited<ReturnType<typeof fetchAndMapCase>>;
  try {
    mapped = await mapCase(
      { docketId, token: cfg.token, hashFirstNEntries: cfg.hashN },
      client,
    );
  } catch (e) {
    // Reconcile the reservation to the calls actually spent, then classify.
    ledger = await reconcileQuota(cfg.ledgerPath, client.requestCount, day);
    const msg = e instanceof Error ? e.message : String(e);
    if (/CourtListener 404/.test(msg)) return { status: "not-found" };
    return { status: "error", message: msg };
  }
  ledger = await reconcileQuota(cfg.ledgerPath, client.requestCount, day);

  const taken = new Set(Object.values(ledger.cases).map((c) => c.handle));
  const handle = deriveHandle(
    mapped.docketRecord.caseName,
    mapped.docketRecord.docketNumber,
    cfg.domain,
    taken,
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

  if (existing) {
    console.warn(
      `WARNING: docket ${docketId} is already provisioned at @${existing.handle}; --force mints a SECOND account (the prior one is archived in the ledger, not deleted from the PDS).`,
    );
  }

  const password = generatePassword();
  const createdAt = new Date().toISOString();
  console.log(`  creating account @${handle}…`);
  const account = await createCaseAccount({
    host: cfg.host,
    adminPassword: cfg.adminPassword,
    handle,
    email: `case-${docketId}@${cfg.domain}`,
    password,
  });

  // Persist credentials immediately — before DNS/records/backfill — so a crash
  // can't orphan the account or lose its (only-stored) password, and a re-run
  // hits the dedupe guard instead of minting a duplicate.
  const entry = {
    did: account.did,
    handle: account.handle,
    password,
    createdAt,
  };
  // recordCase under the lock against a fresh read: a concurrent quota charge
  // (this provision's own reconcile, or another writer) must not be clobbered.
  ledger = await mutateLedger(cfg.ledgerPath, (fresh) =>
    recordCase(fresh, docketId, entry),
  );

  await upsertAtprotoTxt(handle, account.did, {
    zoneId: cfg.zoneId,
    token: cfg.cfToken,
  });

  const repo = await CaseRepo.login({
    host: cfg.host,
    identifier: account.did,
    password,
  });
  // Entries must be written before fireBackfill — it reads them back via
  // listAll(ENTRY) and silently posts nothing if they're absent.
  await repo.applyCreates(rcapeRecords);
  const result = await fireBackfill(repo);

  // highWater is the max recapSequenceNumber from the CL snapshot at provision
  // time, not the live repo; if result.failed is non-empty it may be ahead of
  // what was actually posted (those rkeys are recorded in backfillFailed).
  const sorted = [...mapped.entryRecords].sort((a, b) =>
    (a.recapSequenceNumber ?? "").localeCompare(b.recapSequenceNumber ?? ""),
  );
  ledger = await mutateLedger(cfg.ledgerPath, (fresh) =>
    recordCase(fresh, docketId, {
      ...entry,
      highWater: sorted[sorted.length - 1]?.recapSequenceNumber,
      backfillFailed: result.failed.length > 0 ? result.failed : undefined,
    }),
  );

  return {
    status: "provisioned",
    handle: account.handle,
    did: account.did,
    caseName: mapped.docketRecord.caseName,
    published: result.published,
    failed: result.failed.length,
  };
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
    token: requireEnv("COURTLISTENER_API_TOKEN"),
    host: process.env.PDS_HOSTNAME,
    domain: process.env.RCAPE_HANDLE_DOMAIN ?? "rcape.org",
    hashN: Number(process.env.RCAPE_HASH_FIRST_N ?? "15"),
    // Live-only secrets; not needed for a dry run.
    adminPassword: dryRun ? "" : requireEnv("PDS_ADMIN_PASSWORD"),
    cfToken: dryRun ? "" : requireEnv("CLOUDFLARE_API_TOKEN"),
    zoneId: dryRun ? "" : requireEnv("CLOUDFLARE_ZONE_ID"),
    ledgerPath: ledgerPath(),
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
