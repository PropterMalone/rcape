// pattern: Imperative Shell
// Crash-safe JSON persistence for the bot's only durable stores (ledger.json,
// queue.json). The bot runs under systemd Restart=always, so a crash/OOM/power
// loss mid-write must never leave a torn file: writes go to a same-directory
// temp path then atomically rename() over the target, and the prior good file is
// kept as <path>.bak. Loads recover from .bak when the primary is corrupt rather
// than rethrowing a SyntaxError that would stall the bot forever.
//
// withLock/mutateJson add an advisory O_EXCL lockfile so the always-on bot and
// the operator CLI (provision/fire/takedown) can safely read-modify-write the
// same store cross-process: a concurrent write can't clobber a quota charge or
// a recordCase entry. The lock is in-process best-effort only (it does not
// survive a hard kill mid-section, but the stale-lock timeout reclaims it).

import {
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

// Thrown when neither the primary file nor its .bak parses — the operator must
// intervene, so this surfaces loudly instead of silently resetting state.
export class CorruptStateError extends Error {
  constructor(path: string, cause: unknown) {
    super(
      `refuse to start — corrupt state at ${path}, .bak also unreadable: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = "CorruptStateError";
  }
}

function isEnoent(e: unknown): boolean {
  return (e as NodeJS.ErrnoException).code === "ENOENT";
}

// Atomic write: serialize → write temp → rename over target. The prior good
// target (if any) is copied to <path>.bak before the rename, so a corrupt
// primary on next boot has a recovery source. mkdir is recursive so a fresh
// data/ dir is created on first save.
export async function saveJson<T>(path: string, value: T): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  try {
    await copyFile(path, `${path}.bak`);
  } catch (e) {
    // First-ever save: no prior file to back up. Any other error is real.
    if (!isEnoent(e)) throw e;
  }
  await rename(tmp, path);
}

// Atomic read with recovery: parse the primary; on a parse error (torn file),
// fall back to <path>.bak. ENOENT on the primary returns the caller's default
// (fresh state). If the primary is present-but-corrupt and .bak is missing or
// also corrupt, throw CorruptStateError — never silently reset.
export async function loadJson<T>(path: string, fallback: () => T): Promise<T> {
  let primary: string;
  try {
    primary = await readFile(path, "utf8");
  } catch (e) {
    if (isEnoent(e)) return fallback();
    throw e;
  }
  try {
    return JSON.parse(primary) as T;
  } catch (parseErr) {
    let bak: string;
    try {
      bak = await readFile(`${path}.bak`, "utf8");
    } catch {
      throw new CorruptStateError(path, parseErr);
    }
    try {
      return JSON.parse(bak) as T;
    } catch (bakErr) {
      throw new CorruptStateError(path, bakErr);
    }
  }
}

// A lockfile older than this is presumed orphaned by a dead holder and broken.
// Generous relative to a save (temp-write + rename = milliseconds) so a live,
// slow holder is never preempted mid-section.
const STALE_LOCK_MS = 10_000;
// Total wait before giving up acquiring a held (non-stale) lock.
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_POLL_MS = 25;

function lockPathFor(path: string): string {
  return join(dirname(path), `.${basename(path)}.lock`);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// Acquire an advisory lock for `path` (an O_EXCL lockfile beside it), run `fn`,
// then release the lock — on success and on error. If the lockfile already
// exists, wait and retry until it's released or the timeout elapses; if it's
// older than STALE_LOCK_MS (a crashed holder), break it and proceed.
export async function withLock<T>(
  path: string,
  fn: () => Promise<T>,
): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  const lockPath = lockPathFor(path);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  for (;;) {
    try {
      const handle = await open(lockPath, "wx"); // O_CREAT|O_EXCL
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      break; // acquired
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // Held: break it if stale, else wait and retry until the deadline.
      let mtimeMs = Number.POSITIVE_INFINITY;
      try {
        mtimeMs = (await stat(lockPath)).mtimeMs;
      } catch {
        // The holder released between our open and stat; loop to re-acquire.
      }
      if (Date.now() - mtimeMs > STALE_LOCK_MS) {
        await unlink(lockPath).catch(() => {}); // break the stale lock (idempotent)
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out acquiring lock for ${path}`);
      }
      await sleep(LOCK_POLL_MS);
    }
  }

  try {
    return await fn();
  } finally {
    await unlink(lockPath).catch(() => {}); // release (idempotent if already gone)
  }
}

// Atomic read-modify-write under the lock: load the current state (or fallback),
// apply `mutate`, and save — all while holding the lock, so a concurrent writer
// can't lose either side's change. This is the cross-process-safe primitive the
// ledger/queue read-modify-write callers use.
export async function mutateJson<T>(
  path: string,
  fallback: () => T,
  mutate: (current: T) => T | Promise<T>,
): Promise<T> {
  return withLock(path, async () => {
    const current = await loadJson(path, fallback);
    const next = await mutate(current);
    await saveJson(path, next);
    return next;
  });
}
