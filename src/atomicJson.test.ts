import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CorruptStateError, loadJson, saveJson } from "./atomicJson.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rcape-atomic-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("saveJson / loadJson", () => {
  it("round-trips a value and returns the fallback for a missing file", async () => {
    const path = join(dir, "state.json");
    expect(await loadJson(path, () => ({ x: 0 }))).toEqual({ x: 0 });
    await saveJson(path, { x: 42 });
    expect(await loadJson(path, () => ({ x: 0 }))).toEqual({ x: 42 });
  });

  it("keeps the prior good file as .bak on each successful save", async () => {
    const path = join(dir, "state.json");
    await saveJson(path, { v: 1 });
    await saveJson(path, { v: 2 });
    expect(JSON.parse(await readFile(`${path}.bak`, "utf8"))).toEqual({ v: 1 });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ v: 2 });
  });

  it("writes via a temp file then rename — never leaves the target truncated", async () => {
    const path = join(dir, "state.json");
    await saveJson(path, { ok: true });
    // No leftover .tmp after a successful save (rename consumed it).
    const entries = await readdir(dir);
    expect(entries).not.toContain("state.json.tmp");
    // And the target parses cleanly (was never written partially).
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ ok: true });
  });

  it("recovers from .bak when the primary file is truncated/corrupt", async () => {
    const path = join(dir, "state.json");
    await saveJson(path, { good: 1 });
    await saveJson(path, { good: 2 }); // now .bak holds {good:1}
    // Simulate a crash mid-write: the primary is a torn JSON fragment.
    await writeFile(path, '{"good": 2, "tru');
    const loaded = await loadJson(path, () => ({ good: 0 }));
    // Recovered from the last-known-good .bak, not the fallback, not a throw.
    expect(loaded).toEqual({ good: 1 });
  });

  it("throws CorruptStateError when both primary and .bak are unreadable", async () => {
    const path = join(dir, "state.json");
    await writeFile(path, "{ broken");
    await writeFile(`${path}.bak`, "also broken {");
    await expect(loadJson(path, () => ({}))).rejects.toBeInstanceOf(
      CorruptStateError,
    );
  });

  it("throws CorruptStateError when the primary is corrupt and no .bak exists", async () => {
    const path = join(dir, "state.json");
    await writeFile(path, "{ broken");
    await expect(loadJson(path, () => ({}))).rejects.toBeInstanceOf(
      CorruptStateError,
    );
  });
});
