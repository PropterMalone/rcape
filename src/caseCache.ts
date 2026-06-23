// pattern: Imperative Shell — disk-backed cache of a CL-fetched, mapped case.
//
// A throttle (or operator restart) mid-provision discards the in-flight fetch.
// Without a cache the next retry re-calls CourtListener for the SAME docket
// (getDocket + ceil(entries/100) + ceil(parties/100) pages + the doc hashes),
// re-burning the shared daily budget on a case it already fetched once. On
// 2026-06-16 docket 63287257 was re-fetched 6× across restarts and never once
// completed — the entire daily quota spent on zero provisions.
//
// Caching the mapped result keyed by docketId lets a retry reuse it for ZERO CL
// calls. The TTL bounds staleness (a live docket can gain filings between fetch
// and a much-later retry); past it, we re-fetch fresh.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { saveJson } from "./atomicJson.js";
import type { MappedCase } from "./build.js";
import type {
  ClDocket,
  ClDocketEntry,
  ClParty,
} from "./courtlistener.types.js";

interface CachedCase {
  savedAt: string;
  mapped: MappedCase;
}

// A retry/restart of a stuck case happens within hours; a day is a generous
// ceiling that still guarantees genuinely stale data is re-fetched.
export const CASE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function cachePath(dir: string, docketId: number): string {
  return `${dir}/${docketId}.json`;
}

// Return the cached MappedCase for `docketId` if present and younger than
// `ttlMs`, else undefined (missing file, parse failure, or stale all map to a
// cache miss — the caller just re-fetches).
export async function loadCachedCase(
  dir: string,
  docketId: number,
  nowMs: number,
  ttlMs: number = CASE_CACHE_TTL_MS,
): Promise<MappedCase | undefined> {
  try {
    const raw = await readFile(cachePath(dir, docketId), "utf8");
    const parsed = JSON.parse(raw) as CachedCase;
    if (
      typeof parsed?.savedAt !== "string" ||
      nowMs - Date.parse(parsed.savedAt) > ttlMs
    ) {
      return undefined;
    }
    return parsed.mapped;
  } catch {
    return undefined;
  }
}

// Persist a freshly-fetched MappedCase so a later retry can skip the CL fetch.
// `nowIso` is the caller's already-stamped timestamp (kept consistent with the
// records' createdAt). Best-effort: a write failure must not fail the provision.
export async function saveCachedCase(
  dir: string,
  docketId: number,
  mapped: MappedCase,
  nowIso: string,
): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(
      cachePath(dir, docketId),
      JSON.stringify({ savedAt: nowIso, mapped } satisfies CachedCase),
    );
  } catch {
    // A cache write failure only costs a future re-fetch; never block provisioning.
  }
}

// Remove the complete cache ({id}.json) once a case is terminally provisioned: a
// completed entry never reads its cache again (the dedupe short-circuits on
// `completed`), so keeping it only grows data/case-cache unbounded as the archive
// fills. Idempotent — a missing file doesn't throw. saveCachedCase writes a bare
// file (no saveJson .bak/.tmp siblings), so only the one path needs removing.
export async function clearCachedCase(
  dir: string,
  docketId: number,
): Promise<void> {
  await rm(cachePath(dir, docketId), { force: true }).catch(() => {});
}

// A PARTIAL fetch, accumulated across one or more rate-limit windows, so dribbled
// capacity advances a big docket instead of restarting it every retry. Stores the
// RAW CL payloads (not mapped records): mapping is a single terminal pure step
// that needs all entries + the cids map at once, and raw storage keeps the
// checkpoint independent of any lexicon-shape change mid-fetch. The `*Started`
// flags disambiguate "phase not begun" from "cursor exhausted" (both *Next=null).
export interface FetchCheckpoint {
  savedAt: string;
  docket?: ClDocket;
  entries: ClDocketEntry[];
  entriesNext: string | null;
  entriesStarted: boolean;
  parties: ClParty[];
  partiesNext: string | null;
  partiesStarted: boolean;
}

// Sibling of the complete cache ({id}.json) with a distinct name + reader, so the
// two coexist and need no migration: an old deployment simply has no .partial.json.
export function checkpointPath(dir: string, docketId: number): string {
  return `${dir}/${docketId}.partial.json`;
}

// The in-flight checkpoint for `docketId` if present and younger than `ttlMs`,
// else undefined (missing/corrupt/stale → cache miss → fetch restarts fresh, the
// same staleness contract as the complete cache).
export async function loadCheckpoint(
  dir: string,
  docketId: number,
  nowMs: number,
  ttlMs: number = CASE_CACHE_TTL_MS,
): Promise<FetchCheckpoint | undefined> {
  try {
    const raw = await readFile(checkpointPath(dir, docketId), "utf8");
    const parsed = JSON.parse(raw) as FetchCheckpoint;
    if (
      typeof parsed?.savedAt !== "string" ||
      nowMs - Date.parse(parsed.savedAt) > ttlMs
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

// Persist progress after a page. Atomic (temp+rename+fsync via saveJson) so a
// crash mid-write loses one window's progress, not all of it. Best-effort: a
// write failure must never turn a throttle into a crash. `nowIso` re-stamps
// savedAt so an actively-dribbling case keeps its checkpoint alive past the TTL.
export async function saveCheckpoint(
  dir: string,
  docketId: number,
  cp: FetchCheckpoint,
  nowIso: string,
): Promise<void> {
  try {
    await saveJson(checkpointPath(dir, docketId), { ...cp, savedAt: nowIso });
  } catch {
    // best-effort; the next window just re-fetches the un-checkpointed tail.
  }
}

// Remove a checkpoint (on completion, or when the docket 404s on resume). Clears
// the saveJson siblings (.bak/.tmp) too. Idempotent — missing files don't throw.
export async function clearCheckpoint(
  dir: string,
  docketId: number,
): Promise<void> {
  const p = checkpointPath(dir, docketId);
  await Promise.all([
    rm(p, { force: true }),
    rm(`${p}.bak`, { force: true }),
    rm(`${p}.tmp`, { force: true }),
  ]).catch(() => {});
}
