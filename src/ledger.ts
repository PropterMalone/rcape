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
  // Per-token daily request counters. CourtListener's 125/day cap is PER TOKEN,
  // so a pool of N tokens gives N independent daily budgets. `counts` is keyed
  // by a non-secret token fingerprint (tokenId); all counters reset on a new day.
  quota: { day: string; counts: Record<string, number> };
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

// Requests left today for ONE token. A different day means that token's counter
// has reset (counters are scoped to quota.day).
export function quotaRemaining(
  ledger: Ledger,
  day: string,
  token: string,
): number {
  const used =
    ledger.quota.day === day ? (ledger.quota.counts[tokenId(token)] ?? 0) : 0;
  return Math.max(0, DAILY_CAP - used);
}

// Charge `n` requests against ONE token for `day`. A new day resets every
// token's counter (counts is rebuilt empty) before applying this charge.
export function chargeQuota(
  ledger: Ledger,
  n: number,
  day: string,
  token: string,
): Ledger {
  const sameDay = ledger.quota.day === day;
  const counts = sameDay ? { ...ledger.quota.counts } : {};
  const id = tokenId(token);
  counts[id] = (counts[id] ?? 0) + n;
  return { ...ledger, quota: { day, counts } };
}

// Pick the first configured token with at least `need` requests left today, or
// undefined when every token is exhausted. A single case must run end-to-end on
// ONE token (CL pagination carries the token), so headroom can't be pooled
// across tokens — we need one token that can cover the whole case.
export function selectToken(
  ledger: Ledger,
  tokens: string[],
  day: string,
  need: number,
): string | undefined {
  return tokens.find((t) => quotaRemaining(ledger, day, t) >= need);
}

function normalizeQuota(q: {
  day?: string;
  counts?: Record<string, number>;
}): Ledger["quota"] {
  return { day: q?.day ?? "", counts: q?.counts ?? {} };
}

function normalize(parsed: Partial<Ledger>): Ledger {
  return {
    cases: parsed.cases ?? {},
    quota: normalizeQuota(parsed.quota ?? {}),
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
