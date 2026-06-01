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

// fsync a directory so a rename within it is durable across power loss. Not
// supported on every platform/filesystem (Windows errors), so failures degrade
// silently — the rename is still atomic, just not guaranteed flushed.
async function syncDir(dir: string): Promise<void> {
  try {
    const dh = await open(dir, "r");
    try {
      await dh.sync();
    } finally {
      await dh.close();
    }
  } catch {
    /* directory fsync unsupported here; rename atomicity still holds */
  }
}

// Atomic write: serialize → write temp (fsynced) → rename over target → fsync
// dir. The prior good target (if any) is copied to <path>.bak before the rename,
// so a corrupt primary on next boot has a recovery source. fsync of the temp
// before the rename, and of the parent dir after, are what make the header's
// "never a torn/zero-length file after power loss" guarantee real: without them
// the rename can be ordered before the data hits disk, leaving a zero-length or
// stale primary after a panic. mkdir is recursive so a fresh data/ dir is made
// on first save.
export async function saveJson<T>(path: string, value: T): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  const fh = await open(tmp, "w");
  try {
    await fh.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await fh.sync(); // flush temp contents to disk BEFORE it's renamed into place
  } finally {
    await fh.close();
  }
  try {
    await copyFile(path, `${path}.bak`);
  } catch (e) {
    // First-ever save: no prior file to back up. Any other error is real.
    if (!isEnoent(e)) throw e;
  }
  await rename(tmp, path);
  await syncDir(dir);
}

// Read + parse <path>.bak. Returns the parsed value boxed in { value }, or
// undefined when no .bak exists; throws CorruptStateError if .bak is present but
// won't parse. Boxing distinguishes "no .bak" from a .bak that legitimately
// holds a falsy value.
async function loadBak<T>(path: string): Promise<{ value: T } | undefined> {
  let bak: string;
  try {
    bak = await readFile(`${path}.bak`, "utf8");
  } catch (e) {
    if (isEnoent(e)) return undefined;
    throw e;
  }
  try {
    return { value: JSON.parse(bak) as T };
  } catch (bakErr) {
    throw new CorruptStateError(path, bakErr);
  }
}

// Atomic read with recovery. Two failure modes both fall back to <path>.bak:
//   - primary present but unparseable (a torn mid-write file), AND
//   - primary MISSING (deleted out-of-band, or a rename that left it absent).
// The original code only recovered from the first, so an out-of-band primary
// loss booted the caller's fallback — for the ledger that means resetting the
// quota counter and dropping every case password. .bak (the prior good state)
// is consulted in both cases. Only a genuinely fresh store (no primary AND no
// .bak) returns the fallback; a missing/corrupt primary with an UNREADABLE .bak
// throws CorruptStateError rather than silently resetting.
export async function loadJson<T>(path: string, fallback: () => T): Promise<T> {
  let primary: string;
  try {
    primary = await readFile(path, "utf8");
  } catch (e) {
    if (!isEnoent(e)) throw e;
    // Primary missing: recover from .bak if it exists, else genuinely fresh.
    const recovered = await loadBak<T>(path);
    return recovered ? recovered.value : fallback();
  }
  try {
    return JSON.parse(primary) as T;
  } catch (parseErr) {
    // Primary torn: .bak is the only recovery source. Unlike a missing primary,
    // a missing .bak here is unrecoverable — we KNOW state existed.
    const recovered = await loadBak<T>(path);
    if (!recovered) throw new CorruptStateError(path, parseErr);
    return recovered.value;
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
