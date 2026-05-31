import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CorruptStateError,
  loadJson,
  mutateJson,
  saveJson,
  withLock,
} from "./atomicJson.js";

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

describe("withLock / mutateJson (cross-process write safety)", () => {
  it("serializes interleaved read-modify-write so neither increment is lost", async () => {
    const path = join(dir, "counter.json");
    await saveJson(path, { n: 0 });

    // Two concurrent mutators each read-then-increment. Without the lock both
    // would read n=0 and write n=1 (one lost update); the lock serializes them.
    const bump = () =>
      mutateJson<{ n: number }>(
        path,
        () => ({ n: 0 }),
        (s) => {
          return { n: s.n + 1 };
        },
      );
    await Promise.all([bump(), bump()]);

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ n: 2 });
  });

  it("releases the lock on success so a later acquire succeeds", async () => {
    const path = join(dir, "state.json");
    await withLock(path, async () => {
      /* hold + release */
    });
    // The lockfile must not linger after a successful run.
    expect(await readdir(dir)).not.toContain(".state.json.lock");
    // A second acquire works (would hang/throw if the lock were stuck).
    let ran = false;
    await withLock(path, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("releases the lock even when the critical section throws", async () => {
    const path = join(dir, "state.json");
    await expect(
      withLock(path, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // Lock released despite the throw → the next acquire succeeds.
    let ran = false;
    await withLock(path, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("breaks a stale lock left by a dead holder (older than the stale timeout)", async () => {
    const path = join(dir, "state.json");
    const lockPath = join(dir, ".state.json.lock");
    // Simulate a crashed holder: a lockfile with a far-past mtime.
    await writeFile(lockPath, "dead-pid");
    const { utimes } = await import("node:fs/promises");
    const past = new Date(Date.now() - 60_000);
    await utimes(lockPath, past, past);

    let ran = false;
    await withLock(path, async () => {
      ran = true;
    });
    expect(ran).toBe(true); // stale lock was broken, not waited on forever
  });
});
