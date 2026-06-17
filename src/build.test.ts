import { describe, expect, it, vi } from "vitest";
import { fetchAndMapCase } from "./build.js";
import type { FetchCheckpoint } from "./caseCache.js";
import { type CourtListenerClient, ThrottledError } from "./courtlistener.js";
import type { ClDocket, ClDocketEntry } from "./courtlistener.types.js";

const docket = {
  id: 1,
  court_id: "nysd",
  docket_number: "1:23-cv-1",
  case_name: "Doe v. Roe",
} as unknown as ClDocket;

const entry = (id: number): ClDocketEntry =>
  ({
    id,
    entry_number: id,
    recap_sequence_number: `s${id}`,
    date_filed: "2025-01-01",
    description: `e${id}`,
    recap_documents: [],
  }) as unknown as ClDocketEntry;

const opts = { docketId: 1, token: "t", hashFirstNEntries: 0 };

// Structural mock — fetchAndMapCase only calls getDocket/fetchDocketEntries/
// fetchParties. Defaults: docket present, both lists empty + complete.
function mockClient(
  over: Partial<Record<string, unknown>> = {},
): CourtListenerClient {
  return {
    getDocket: async () => docket,
    fetchDocketEntries: async () => ({ results: [], next: null }),
    fetchParties: async () => ({ results: [], next: null }),
    ...over,
  } as unknown as CourtListenerClient;
}

const freshCheckpoint = (
  over: Partial<FetchCheckpoint> = {},
): FetchCheckpoint => ({
  savedAt: "2026-06-17T18:00:00.000Z",
  docket,
  entries: [entry(1)],
  entriesNext: "CURSOR2",
  entriesStarted: true,
  parties: [],
  partiesNext: null,
  partiesStarted: false,
  ...over,
});

describe("fetchAndMapCase resume", () => {
  it("resumes entries from the checkpoint cursor (not page 1) and reuses the cached docket", async () => {
    const resumeArgs: Array<string | null | undefined> = [];
    const getDocket = vi.fn(async () => docket);
    const client = mockClient({
      getDocket,
      fetchDocketEntries: async (
        _id: number,
        o?: {
          resumeFrom?: string | null;
          onPage?: (r: ClDocketEntry[], n: string | null) => Promise<void>;
        },
      ) => {
        resumeArgs.push(o?.resumeFrom);
        await o?.onPage?.([entry(2)], null);
        return { results: [entry(2)], next: null };
      },
    });
    const mapped = await fetchAndMapCase(opts, client, {
      checkpoint: freshCheckpoint(),
    });
    expect(resumeArgs).toEqual(["CURSOR2"]); // jumped to the saved cursor
    expect(getDocket).not.toHaveBeenCalled(); // checkpoint.docket reused
    expect(mapped.entryRecords.map((e) => e.recapSequenceNumber)).toEqual([
      "s1",
      "s2",
    ]);
  });

  it("dedupes an overlapping boundary entry by id", async () => {
    const client = mockClient({
      fetchDocketEntries: async (
        _id: number,
        o?: {
          onPage?: (r: ClDocketEntry[], n: string | null) => Promise<void>;
        },
      ) => {
        // resumed page re-includes entry 1 (boundary overlap) + new entry 2
        await o?.onPage?.([entry(1), entry(2)], null);
        return { results: [entry(1), entry(2)], next: null };
      },
    });
    const mapped = await fetchAndMapCase(opts, client, {
      checkpoint: freshCheckpoint(),
    });
    expect(mapped.entryRecords).toHaveLength(2); // not 3
  });

  it("calls onProgress after each page with a growing checkpoint", async () => {
    const snaps: Array<{ n: number; next: string | null }> = [];
    const client = mockClient({
      fetchDocketEntries: async (
        _id: number,
        o?: {
          onPage?: (r: ClDocketEntry[], n: string | null) => Promise<void>;
        },
      ) => {
        await o?.onPage?.([entry(1)], "C2");
        await o?.onPage?.([entry(2)], null);
        return { results: [entry(1), entry(2)], next: null };
      },
    });
    await fetchAndMapCase(opts, client, {
      onProgress: async (cp) => {
        snaps.push({ n: cp.entries.length, next: cp.entriesNext });
      },
    });
    expect(snaps).toContainEqual({ n: 1, next: "C2" });
    expect(snaps).toContainEqual({ n: 2, next: null });
  });

  it("propagates a ThrottledError AFTER checkpointing the last good page", async () => {
    const persistedCounts: number[] = [];
    const client = mockClient({
      fetchDocketEntries: async (
        _id: number,
        o?: {
          onPage?: (r: ClDocketEntry[], n: string | null) => Promise<void>;
        },
      ) => {
        await o?.onPage?.([entry(1)], "C2"); // page 1 succeeds + persists
        throw new ThrottledError(5000); // page 2 throttles
      },
    });
    await expect(
      fetchAndMapCase(opts, client, {
        onProgress: async (cp) => {
          persistedCounts.push(cp.entries.length);
        },
      }),
    ).rejects.toBeInstanceOf(ThrottledError);
    expect(persistedCounts).toContain(1); // page 1 was durably checkpointed
  });

  it("rethrows a parties ThrottledError instead of false-completing with zero parties", async () => {
    const client = mockClient({
      fetchParties: async () => {
        throw new ThrottledError(5000);
      },
    });
    await expect(fetchAndMapCase(opts, client)).rejects.toBeInstanceOf(
      ThrottledError,
    );
  });

  it("tolerates a non-throttle parties failure (parties stay empty)", async () => {
    const client = mockClient({
      fetchParties: async () => {
        throw new Error("parties boom");
      },
    });
    const mapped = await fetchAndMapCase(opts, client);
    expect(mapped.parties).toEqual([]);
  });
});
