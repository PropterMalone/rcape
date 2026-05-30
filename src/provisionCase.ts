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
  chargeQuota,
  findCase,
  loadLedger,
  quotaRemaining,
  recordCase,
  saveLedger,
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

export type ProvisionResult =
  | {
      status: "provisioned";
      handle: string;
      did: string;
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

// Provision a case end-to-end, in-process. Callable by both the operator CLI
// (main, below) and the @-mention bot. Reuses the early-persist + archive +
// quota logic; returns a discriminated result the caller maps to output/replies.
export async function runProvision(
  docketId: number,
  cfg: ProvisionConfig,
  opts: { force?: boolean; dryRun?: boolean } = {},
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

  const client = new CourtListenerClient(cfg.token);
  let mapped: Awaited<ReturnType<typeof fetchAndMapCase>>;
  try {
    mapped = await fetchAndMapCase(
      { docketId, token: cfg.token, hashFirstNEntries: cfg.hashN },
      client,
    );
  } catch (e) {
    // Charge the calls we spent before the failure, then classify.
    ledger = chargeQuota(ledger, client.requestCount, day);
    await saveLedger(cfg.ledgerPath, ledger);
    const msg = e instanceof Error ? e.message : String(e);
    if (/CourtListener 404/.test(msg)) return { status: "not-found" };
    return { status: "error", message: msg };
  }
  ledger = chargeQuota(ledger, client.requestCount, day);
  await saveLedger(cfg.ledgerPath, ledger);

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
  ledger = recordCase(ledger, docketId, entry);
  await saveLedger(cfg.ledgerPath, ledger);

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
  ledger = recordCase(ledger, docketId, {
    ...entry,
    highWater: sorted[sorted.length - 1]?.recapSequenceNumber,
    backfillFailed: result.failed.length > 0 ? result.failed : undefined,
  });
  await saveLedger(cfg.ledgerPath, ledger);

  return {
    status: "provisioned",
    handle: account.handle,
    did: account.did,
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
