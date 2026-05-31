// pattern: Imperative Shell
// Crash-safe JSON persistence for the bot's only durable stores (ledger.json,
// queue.json). The bot runs under systemd Restart=always, so a crash/OOM/power
// loss mid-write must never leave a torn file: writes go to a same-directory
// temp path then atomically rename() over the target, and the prior good file is
// kept as <path>.bak. Loads recover from .bak when the primary is corrupt rather
// than rethrowing a SyntaxError that would stall the bot forever.
// Finding 11 will reuse this module for the advisory lock.

import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

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
