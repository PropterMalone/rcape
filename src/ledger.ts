// pattern: Functional Core (pure ledger ops) + thin I/O shell (load / save)
// Persistent record of provisioned cases (CL docket id -> account) for dedupe,
// plus a per-day CourtListener request counter so on-demand provisioning stays
// under the shared free-tier cap. Holds per-case account passwords, so it lives
// in the gitignored data/ directory.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface CaseEntry {
  did: string;
  handle: string;
  password: string;
  createdAt: string;
  // High-water recapSequenceNumber for the (future) watched-case monitor.
  highWater?: string;
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
  return {
    ...ledger,
    cases: { ...ledger.cases, [String(docketId)]: entry },
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
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<Ledger>;
    return {
      cases: parsed.cases ?? {},
      quota: parsed.quota ?? { day: "", count: 0 },
    };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return emptyLedger();
    throw e;
  }
}

export async function saveLedger(path: string, ledger: Ledger): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(ledger, null, 2)}\n`);
}
