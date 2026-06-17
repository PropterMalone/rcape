import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MappedCase } from "./build.js";
import {
  CASE_CACHE_TTL_MS,
  type FetchCheckpoint,
  checkpointPath,
  clearCheckpoint,
  loadCachedCase,
  loadCheckpoint,
  saveCachedCase,
  saveCheckpoint,
} from "./caseCache.js";
import type { ClDocketEntry } from "./courtlistener.types.js";

const sample: MappedCase = {
  docketRecord: { caseName: "Doe v. Roe" } as MappedCase["docketRecord"],
  entryRecords: [],
  parties: [],
  records: [],
};

describe("caseCache", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "rcape-cache-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns undefined on a cold cache", async () => {
    expect(await loadCachedCase(dir, 123, Date.now())).toBeUndefined();
  });

  it("round-trips a saved case within the TTL", async () => {
    const now = "2026-06-16T20:00:00.000Z";
    await saveCachedCase(dir, 123, sample, now);
    const got = await loadCachedCase(dir, 123, Date.parse(now) + 1000);
    expect(got?.docketRecord.caseName).toBe("Doe v. Roe");
  });

  it("treats an entry older than the TTL as a miss", async () => {
    const saved = "2026-06-16T20:00:00.000Z";
    await saveCachedCase(dir, 123, sample, saved);
    const wayLater = Date.parse(saved) + CASE_CACHE_TTL_MS + 1;
    expect(await loadCachedCase(dir, 123, wayLater)).toBeUndefined();
  });

  it("keys by docketId (no cross-talk)", async () => {
    await saveCachedCase(dir, 123, sample, "2026-06-16T20:00:00.000Z");
    expect(
      await loadCachedCase(dir, 999, Date.parse("2026-06-16T20:00:01.000Z")),
    ).toBeUndefined();
  });

  it("treats a corrupt cache file as a miss", async () => {
    await writeFile(join(dir, "123.json"), "{not json");
    expect(await loadCachedCase(dir, 123, Date.now())).toBeUndefined();
  });

  it("does not throw when the save directory is unwritable mid-path", async () => {
    // A non-existent nested dir is created; an outright bad path is swallowed.
    await expect(
      saveCachedCase(
        `${dir}/nested/deep`,
        1,
        sample,
        "2026-06-16T20:00:00.000Z",
      ),
    ).resolves.toBeUndefined();
    const back = await readFile(join(dir, "nested/deep", "1.json"), "utf8");
    expect(JSON.parse(back).mapped.docketRecord.caseName).toBe("Doe v. Roe");
  });
});

const entry = (id: number): ClDocketEntry =>
  ({ id, recap_sequence_number: `s${id}` }) as unknown as ClDocketEntry;

const checkpoint = (over: Partial<FetchCheckpoint> = {}): FetchCheckpoint => ({
  savedAt: "2026-06-17T18:00:00.000Z",
  entries: [entry(1)],
  entriesNext:
    "https://www.courtlistener.com/api/rest/v4/docket-entries/?cursor=p2",
  entriesStarted: true,
  parties: [],
  partiesNext: null,
  partiesStarted: false,
  ...over,
});

describe("caseCache checkpoint", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "rcape-cp-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns undefined on a cold checkpoint", async () => {
    expect(await loadCheckpoint(dir, 123, Date.now())).toBeUndefined();
  });

  it("round-trips a checkpoint within the TTL and re-stamps savedAt", async () => {
    const now = "2026-06-17T18:30:00.000Z";
    await saveCheckpoint(dir, 123, checkpoint(), now);
    const got = await loadCheckpoint(dir, 123, Date.parse(now) + 1000);
    expect(got?.entries.map((e) => e.id)).toEqual([1]);
    expect(got?.entriesNext).toContain("cursor=p2");
    expect(got?.savedAt).toBe(now); // re-stamped, not the fixture's value
  });

  it("treats a checkpoint older than the TTL as a miss", async () => {
    const saved = "2026-06-17T18:00:00.000Z";
    await saveCheckpoint(dir, 123, checkpoint(), saved);
    expect(
      await loadCheckpoint(dir, 123, Date.parse(saved) + CASE_CACHE_TTL_MS + 1),
    ).toBeUndefined();
  });

  it("coexists with the complete cache of the same docketId", async () => {
    await saveCachedCase(dir, 123, sample, "2026-06-17T18:00:00.000Z");
    await saveCheckpoint(dir, 123, checkpoint(), "2026-06-17T18:00:00.000Z");
    expect(
      (await loadCachedCase(dir, 123, Date.parse("2026-06-17T18:00:01.000Z")))
        ?.docketRecord.caseName,
    ).toBe("Doe v. Roe");
    expect(
      (await loadCheckpoint(dir, 123, Date.parse("2026-06-17T18:00:01.000Z")))
        ?.entriesNext,
    ).toContain("cursor=p2");
  });

  it("clearCheckpoint removes the file (idempotent) and leaves no .tmp", async () => {
    await saveCheckpoint(dir, 123, checkpoint(), "2026-06-17T18:00:00.000Z");
    await clearCheckpoint(dir, 123);
    expect(await loadCheckpoint(dir, 123, Date.now())).toBeUndefined();
    await expect(access(`${checkpointPath(dir, 123)}.tmp`)).rejects.toThrow();
    // clearing again is a no-op, not a throw
    await expect(clearCheckpoint(dir, 123)).resolves.toBeUndefined();
  });
});
