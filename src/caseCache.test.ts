import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MappedCase } from "./build.js";
import {
  CASE_CACHE_TTL_MS,
  loadCachedCase,
  saveCachedCase,
} from "./caseCache.js";

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
