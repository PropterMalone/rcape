// pattern: Functional Core (pure queue ops) + thin I/O shell (load / save)
// Persistent job queue for the @-mention bot: one active job per docket, drained
// under the CL daily budget. Also tracks processed notification URIs so each
// mention is handled exactly once across restarts. Lives in gitignored data/.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

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
  status: "queued" | "done" | "failed";
  createdAt: string;
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

export function perRequesterQueued(q: QueueState, did: string): number {
  return q.jobs.filter((j) => j.status === "queued" && j.requesterDid === did)
    .length;
}

export type EnqueueResult =
  | { ok: true; queue: QueueState }
  | { ok: false; reason: "duplicate" | "requester-cap" };

// Reject a docket already queued/in-flight, or a requester at their cap.
export function enqueue(
  q: QueueState,
  job: Job,
  opts: { perRequesterCap: number },
): EnqueueResult {
  const active = q.jobs.find(
    (j) => j.docketId === job.docketId && j.status === "queued",
  );
  if (active) return { ok: false, reason: "duplicate" };
  if (perRequesterQueued(q, job.requesterDid) >= opts.perRequesterCap) {
    return { ok: false, reason: "requester-cap" };
  }
  return { ok: true, queue: { ...q, jobs: [...q.jobs, job] } };
}

export function nextQueued(q: QueueState): Job | undefined {
  return q.jobs.find((j) => j.status === "queued");
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

export function hasSeen(q: QueueState, uri: string): boolean {
  return q.seen.includes(uri);
}

export function markSeen(q: QueueState, uri: string): QueueState {
  if (q.seen.includes(uri)) return q;
  const seen = [...q.seen, uri];
  // Bound the set so it can't grow without limit; keep the most recent.
  return { ...q, seen: seen.slice(-SEEN_CAP) };
}

export async function loadQueue(path: string): Promise<QueueState> {
  try {
    const parsed = JSON.parse(
      await readFile(path, "utf8"),
    ) as Partial<QueueState>;
    return { jobs: parsed.jobs ?? [], seen: parsed.seen ?? [] };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return emptyQueue();
    throw e;
  }
}

export async function saveQueue(path: string, q: QueueState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(q, null, 2)}\n`);
}
