// pattern: Functional Core (pure queue ops) + thin I/O shell (load / save / mutate)
// The low-priority PRE-SHELVE queue: dockets harvested from a private set of
// journalist feeds (see harvest.ts) that the bot shelves opportunistically with
// spare quota near the daily reset. Kept SEPARATE from the by-request queue.ts —
// a pre-shelve job has no requester, no mention/reply lifecycle, and must never
// compete with or starve a real request. Persisted under data/ via atomicJson.

import { loadJson, mutateJson, saveJson } from "./atomicJson.js";

export type PreshelveStatus = "pending" | "done" | "failed";

export interface PreshelveJob {
  docketId: number;
  // The handle/DID the docket link was harvested from. INTERNAL ONLY — for logs
  // and debugging; it must never reach any public record or post (consent gate).
  source: string;
  discoveredAt: string; // ISO
  status: PreshelveStatus;
}

export interface PreshelveQueue {
  jobs: PreshelveJob[];
}

export function emptyPreshelveQueue(): PreshelveQueue {
  return { jobs: [] };
}

export function findPreshelveJob(
  q: PreshelveQueue,
  docketId: number,
): PreshelveJob | undefined {
  return q.jobs.find((j) => j.docketId === docketId);
}

// Append a job, deduped by docketId: a docket already in the queue in ANY status
// (pending/done/failed) is left untouched — once harvested it's not re-queued,
// even after it completes, so the queue doesn't re-shelve or thrash on it.
export function enqueuePreshelve(
  q: PreshelveQueue,
  job: PreshelveJob,
): PreshelveQueue {
  if (findPreshelveJob(q, job.docketId)) return q;
  return { jobs: [...q.jobs, job] };
}

export function pendingPreshelve(q: PreshelveQueue): PreshelveJob[] {
  return q.jobs.filter((j) => j.status === "pending");
}

// The oldest pending job (FIFO by discovery), or undefined when none pend.
export function nextPendingPreshelve(
  q: PreshelveQueue,
): PreshelveJob | undefined {
  return pendingPreshelve(q).sort((a, b) =>
    a.discoveredAt < b.discoveredAt
      ? -1
      : a.discoveredAt > b.discoveredAt
        ? 1
        : 0,
  )[0];
}

function setStatus(
  q: PreshelveQueue,
  docketId: number,
  status: PreshelveStatus,
): PreshelveQueue {
  return {
    jobs: q.jobs.map((j) => (j.docketId === docketId ? { ...j, status } : j)),
  };
}

export function markPreshelveDone(
  q: PreshelveQueue,
  docketId: number,
): PreshelveQueue {
  return setStatus(q, docketId, "done");
}

export function markPreshelveFailed(
  q: PreshelveQueue,
  docketId: number,
): PreshelveQueue {
  return setStatus(q, docketId, "failed");
}

// ---- I/O shell ----

export function loadPreshelveQueue(path: string): Promise<PreshelveQueue> {
  return loadJson<PreshelveQueue>(path, emptyPreshelveQueue);
}

export function savePreshelveQueue(
  path: string,
  q: PreshelveQueue,
): Promise<void> {
  return saveJson(path, q);
}

export function mutatePreshelveQueue(
  path: string,
  mutate: (q: PreshelveQueue) => PreshelveQueue,
): Promise<PreshelveQueue> {
  return mutateJson(path, emptyPreshelveQueue, mutate);
}
