// pattern: Functional Core (pure queue ops) + thin I/O shell (load / save)
// Persistent job queue for the @-mention bot: one active job per docket, drained
// under the CL daily budget. Also tracks processed notification URIs so each
// mention is handled exactly once across restarts. Lives in gitignored data/.
//
// LOCK CONTRACT: the bot is the queue's single writer, but a read-modify-write
// of queue.json still goes through mutateQueue (advisory lock + re-read under
// the lock) so two pollOnce cycles — or a future tool — can't clobber each
// other. A bare saveQueue overwrites the whole file; use mutateQueue for any
// load-then-modify-then-save, and reserve saveQueue for from-scratch writes.

import { loadJson, mutateJson, saveJson } from "./atomicJson.js";

export interface StrongRef {
  uri: string;
  cid: string;
}

export interface Job {
  docketId: number;
  requesterDid: string;
  requesterHandle: string;
  mention: StrongRef; // the mentioning post (parent of the ack)
  rootRef: StrongRef; // thread root
  ackRef?: StrongRef; // set after the ack is posted; parent of the done reply
  // "retrying": a transient provision error backed off until nextAttemptAt.
  status: "queued" | "retrying" | "done" | "failed";
  createdAt: string;
  retryCount?: number; // transient-failure attempts so far (drives backoff + cap)
  nextAttemptAt?: string; // ISO time the retrying job becomes drainable again
}

export interface QueueState {
  jobs: Job[];
  seen: string[]; // processed notification URIs (bounded)
}

const SEEN_CAP = 1000;

export function emptyQueue(): QueueState {
  return { jobs: [], seen: [] };
}

export function findJob(q: QueueState, docketId: number): Job | undefined {
  return q.jobs.find((j) => j.docketId === docketId);
}

// A job is "active" (not yet terminal) while it's queued or backing off a retry.
function isActive(j: Job): boolean {
  return j.status === "queued" || j.status === "retrying";
}

export function perRequesterQueued(q: QueueState, did: string): number {
  return q.jobs.filter((j) => isActive(j) && j.requesterDid === did).length;
}

export type EnqueueResult =
  | { ok: true; queue: QueueState }
  | { ok: false; reason: "duplicate" | "requester-cap" };

// Reject a docket already queued/in-flight (including mid-retry), or a requester
// at their cap.
export function enqueue(
  q: QueueState,
  job: Job,
  opts: { perRequesterCap: number },
): EnqueueResult {
  const active = q.jobs.find((j) => j.docketId === job.docketId && isActive(j));
  if (active) return { ok: false, reason: "duplicate" };
  if (perRequesterQueued(q, job.requesterDid) >= opts.perRequesterCap) {
    return { ok: false, reason: "requester-cap" };
  }
  return { ok: true, queue: { ...q, jobs: [...q.jobs, job] } };
}

// The first fresh (never-attempted) queued job. Retains the original FIFO
// semantics for callers that don't care about retries.
export function nextQueued(q: QueueState): Job | undefined {
  return q.jobs.find((j) => j.status === "queued");
}

// The next job ready to drain: a fresh queued job, or a retrying job whose
// backoff (nextAttemptAt) has elapsed. A retrying job still in its backoff
// window is SKIPPED, not blocking — a later ready job is returned instead, so a
// stuck job can't head-of-line block the whole queue.
export function nextDrainable(q: QueueState, now: number): Job | undefined {
  return q.jobs.find((j) => {
    if (j.status === "queued") return true;
    if (j.status === "retrying") {
      return Date.parse(j.nextAttemptAt ?? "") <= now;
    }
    return false;
  });
}

function patchJob(
  q: QueueState,
  docketId: number,
  patch: Partial<Job>,
): QueueState {
  return {
    ...q,
    jobs: q.jobs.map((j) => (j.docketId === docketId ? { ...j, ...patch } : j)),
  };
}

export function setAck(
  q: QueueState,
  docketId: number,
  ackRef: StrongRef,
): QueueState {
  return patchJob(q, docketId, { ackRef });
}

export function markDone(q: QueueState, docketId: number): QueueState {
  return patchJob(q, docketId, { status: "done" });
}

export function markFailed(q: QueueState, docketId: number): QueueState {
  return patchJob(q, docketId, { status: "failed" });
}

// Back a transiently-failed job off: bump retryCount and set nextAttemptAt so
// drain won't re-pick it until the backoff window elapses. The caller decides
// (via retryCount vs a cap) whether to retry or markFailed.
export function markRetrying(
  q: QueueState,
  docketId: number,
  nextAttemptAt: string,
): QueueState {
  const job = findJob(q, docketId);
  const retryCount = (job?.retryCount ?? 0) + 1;
  return patchJob(q, docketId, {
    status: "retrying",
    retryCount,
    nextAttemptAt,
  });
}

export function hasSeen(q: QueueState, uri: string): boolean {
  return q.seen.includes(uri);
}

export function markSeen(q: QueueState, uri: string): QueueState {
  if (q.seen.includes(uri)) return q;
  const seen = [...q.seen, uri];
  // Bound the set so it can't grow without limit; keep the most recent.
  return { ...q, seen: seen.slice(-SEEN_CAP) };
}

function normalize(parsed: Partial<QueueState>): QueueState {
  return { jobs: parsed.jobs ?? [], seen: parsed.seen ?? [] };
}

export async function loadQueue(path: string): Promise<QueueState> {
  return normalize(await loadJson<Partial<QueueState>>(path, emptyQueue));
}

export async function saveQueue(path: string, q: QueueState): Promise<void> {
  await saveJson(path, q);
}

// Cross-process-safe read-modify-write of the queue: re-reads under an advisory
// lock, applies `mutate`, and saves atomically. `mutate` receives the freshly
// re-read queue so a concurrent writer's change isn't lost.
export async function mutateQueue(
  path: string,
  mutate: (q: QueueState) => QueueState | Promise<QueueState>,
): Promise<QueueState> {
  return mutateJson<QueueState>(path, emptyQueue, async (parsed) =>
    mutate(normalize(parsed)),
  );
}
