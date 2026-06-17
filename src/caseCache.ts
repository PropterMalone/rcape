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
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { MappedCase } from "./build.js";

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
