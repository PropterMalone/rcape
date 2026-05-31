// pattern: Functional Core (pure ledger ops) + thin I/O shell (load / save)
// Persistent record of provisioned cases (CL docket id -> account) for dedupe,
// plus a per-day CourtListener request counter so on-demand provisioning stays
// under the shared free-tier cap. Holds per-case account passwords, so it lives
// in the gitignored data/ directory.

import { loadJson, saveJson } from "./atomicJson.js";

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
  if (prior && prior.did !== entry.did) {
    // Different DID at the same docket = a --force re-provision displaced the
    // old account. Archive it (flattened) so its credentials survive.
    const { superseded: priorArchive, ...priorRest } = prior;
    toStore = { ...entry, superseded: [...(priorArchive ?? []), priorRest] };
  } else if (prior?.superseded && !entry.superseded) {
    // Same DID = an in-place update (e.g. the post-backfill highWater write).
    // Preserve any existing archive across the update.
    toStore = { ...entry, superseded: prior.superseded };
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

export async function loadLedger(path: string): Promise<Ledger> {
  const parsed = await loadJson<Partial<Ledger>>(path, emptyLedger);
  return {
    cases: parsed.cases ?? {},
    quota: parsed.quota ?? { day: "", count: 0 },
  };
}

export async function saveLedger(path: string, ledger: Ledger): Promise<void> {
  await saveJson(path, ledger);
}
