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
import { createCaseAccount, generatePassword } from "./provision.js";
import { prune } from "./repo.js";

export function parseDocketId(arg: string | undefined): number | null {
  if (!arg) return null;
  if (/^\d+$/.test(arg)) return Number(arg);
  const m = arg.match(/docket\/(\d+)/);
  return m ? Number(m[1]) : null;
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

  const token = requireEnv("COURTLISTENER_API_TOKEN");
  const host = process.env.PDS_HOSTNAME;
  const domain = process.env.RCAPE_HANDLE_DOMAIN ?? "rcape.org";
  const hashN = Number(process.env.RCAPE_HASH_FIRST_N ?? "15");
  const path = ledgerPath();
  let ledger = await loadLedger(path);

  const existing = findCase(ledger, docketId);
  if (existing && !force) {
    console.log(
      `already provisioned: docket ${docketId} -> @${existing.handle} (${existing.did})`,
    );
    console.log("pass --force to re-run (creates a duplicate account).");
    return;
  }

  const day = new Date().toISOString().slice(0, 10);
  const remaining = quotaRemaining(ledger, day);
  if (remaining <= 0) {
    throw new Error(
      `CourtListener daily quota exhausted (${day}); try again tomorrow.`,
    );
  }

  const client = new CourtListenerClient(token);
  console.log(
    `Provisioning docket ${docketId} (${remaining} CL calls left today)…`,
  );
  // Validates the docket exists — fetchAndMapCase throws on a CL 404.
  const mapped = await fetchAndMapCase(
    { docketId, token, hashFirstNEntries: hashN },
    client,
  );
  // CL calls are real spend — persist the quota charge now so it survives any
  // later failure (the 125/day cap is shared across every case).
  ledger = chargeQuota(ledger, client.requestCount, day);
  await saveLedger(path, ledger);

  const taken = new Set(Object.values(ledger.cases).map((c) => c.handle));
  const handle = deriveHandle(
    mapped.docketRecord.caseName,
    mapped.docketRecord.docketNumber,
    domain,
    taken,
  );
  const rcapeRecords = mapped.records.map((r) => ({
    collection: r.collection,
    rkey: r.rkey,
    value: prune(r.record),
  }));

  console.log(`  case:    ${mapped.docketRecord.caseName}`);
  console.log(`  docket:  ${mapped.docketRecord.docketNumber}`);
  console.log(`  handle:  @${handle}`);
  console.log(
    `  records: ${rcapeRecords.length} (1 docket + ${mapped.entryRecords.length} entries + ${mapped.parties.length} parties)`,
  );
  console.log(`  posts:   ${mapped.entryRecords.length} backdated + 1 seed`);
  console.log(`  CL spend this run: ${client.requestCount} calls`);

  if (dryRun) {
    // Quota was already saved above; dry-run writes nothing else.
    console.log(
      "=== [dry-run] no account, no DNS, no records/posts written ===",
    );
    console.log(`would create _atproto.${handle} TXT = did=<new did>`);
    return;
  }

  if (existing) {
    console.warn(
      `WARNING: docket ${docketId} is already provisioned at @${existing.handle}; --force mints a SECOND account. The prior one is archived in the ledger (not deleted from the PDS).`,
    );
  }

  const adminPassword = requireEnv("PDS_ADMIN_PASSWORD");
  const cfToken = requireEnv("CLOUDFLARE_API_TOKEN");
  const zoneId = requireEnv("CLOUDFLARE_ZONE_ID");
  const password = generatePassword();
  const createdAt = new Date().toISOString();

  console.log("creating account…");
  const account = await createCaseAccount({
    host,
    adminPassword,
    handle,
    email: `case-${docketId}@${domain}`,
    password,
  });
  console.log(`  did: ${account.did}`);

  // Persist credentials immediately — before DNS/records/backfill — so a crash
  // in any later step can't orphan the account or lose its (only-stored)
  // password, and a re-run hits the dedupe guard instead of minting a duplicate.
  const entry = {
    did: account.did,
    handle: account.handle,
    password,
    createdAt,
  };
  ledger = recordCase(ledger, docketId, entry);
  await saveLedger(path, ledger);

  const dns = await upsertAtprotoTxt(handle, account.did, {
    zoneId,
    token: cfToken,
  });
  console.log(
    `  _atproto.${handle} TXT ${dns.created ? "created" : "updated"}`,
  );

  const repo = await CaseRepo.login({
    host,
    identifier: account.did,
    password,
  });
  // Entries must be written before fireBackfill — it reads them back via
  // listAll(ENTRY) and silently posts nothing if they're absent.
  await repo.applyCreates(rcapeRecords);
  console.log(`  wrote ${rcapeRecords.length} records`);
  const result = await fireBackfill(repo);
  console.log(
    `  backfill: ${result.published} published, ${result.failed.length} failed`,
  );

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
  await saveLedger(path, ledger);
  console.log(`done — @${handle} provisioned and recorded in the ledger.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
