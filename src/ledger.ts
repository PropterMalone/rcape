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

import { loadJson, mutateJson, saveJson } from "./atomicJson.js";

export interface CaseEntry {
  did: string;
  handle: string;
  password: string;
  createdAt: string;
  // High-water recapSequenceNumber for the (future) watched-case monitor.
  highWater?: string;
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
  quota: { day: string; count: number };
}

// CourtListener free tier: 125 requests/day per token, shared across all cases.
export const DAILY_CAP = 125;

export function emptyLedger(): Ledger {
  return { cases: {}, quota: { day: "", count: 0 } };
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
  // A genuinely different DID (the incoming entry names one and it differs from
  // prior) means a --force re-provision displaced the old account. A partial
  // update that omits `did` is NOT a DID change.
  const isForceReprovision = prior && entry.did && prior.did !== entry.did;
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

export function quotaRemaining(ledger: Ledger, day: string): number {
  const used = ledger.quota.day === day ? ledger.quota.count : 0;
  return Math.max(0, DAILY_CAP - used);
}

export function chargeQuota(ledger: Ledger, n: number, day: string): Ledger {
  const used = ledger.quota.day === day ? ledger.quota.count : 0;
  return { ...ledger, quota: { day, count: used + n } };
}

function normalize(parsed: Partial<Ledger>): Ledger {
  return {
    cases: parsed.cases ?? {},
    quota: parsed.quota ?? { day: "", count: 0 },
  };
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
