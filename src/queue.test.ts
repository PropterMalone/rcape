import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type Job,
  type QueueState,
  emptyQueue,
  enqueue,
  findJob,
  hasSeen,
  loadQueue,
  markDone,
  markFailed,
  markSeen,
  nextQueued,
  perRequesterQueued,
  saveQueue,
  setAck,
} from "./queue.js";

const ref = (uri: string) => ({ uri, cid: `cid-${uri}` });

function job(docketId: number, requesterDid: string): Job {
  return {
    docketId,
    requesterDid,
    requesterHandle: "alice.test",
    mention: ref(`m${docketId}`),
    rootRef: ref(`m${docketId}`),
    status: "queued",
    createdAt: "2026-05-30T00:00:00.000Z",
  };
}

function enq(q: QueueState, j: Job, cap = 3): QueueState {
  const r = enqueue(q, j, { perRequesterCap: cap });
  if (!r.ok) throw new Error(`unexpected reject: ${r.reason}`);
  return r.queue;
}

describe("enqueue", () => {
  it("adds a job and is FIFO via nextQueued", () => {
    let q = emptyQueue();
    q = enq(q, job(1, "did:a"));
    q = enq(q, job(2, "did:a"));
    expect(nextQueued(q)?.docketId).toBe(1);
  });

  it("rejects a docket already queued (dedupe)", () => {
    const q = enq(emptyQueue(), job(1, "did:a"));
    const r = enqueue(q, job(1, "did:b"), { perRequesterCap: 3 });
    expect(r).toEqual({ ok: false, reason: "duplicate" });
  });

  it("re-queues a docket once the prior job is done", () => {
    let q = enq(emptyQueue(), job(1, "did:a"));
    q = markDone(q, 1);
    const r = enqueue(q, job(1, "did:b"), { perRequesterCap: 3 });
    expect(r.ok).toBe(true);
  });

  it("rejects a requester over their cap (queued jobs only)", () => {
    let q = emptyQueue();
    q = enq(q, job(1, "did:a"));
    q = enq(q, job(2, "did:a"));
    const r = enqueue(q, job(3, "did:a"), { perRequesterCap: 2 });
    expect(r).toEqual({ ok: false, reason: "requester-cap" });
    expect(perRequesterQueued(q, "did:a")).toBe(2);
  });
});

describe("lifecycle", () => {
  it("records the ack ref and skips done jobs in nextQueued", () => {
    let q = enq(emptyQueue(), job(1, "did:a"));
    q = setAck(q, 1, ref("ack1"));
    expect(q.jobs[0]?.ackRef?.uri).toBe("ack1");
    q = markDone(q, 1);
    expect(nextQueued(q)).toBeUndefined();
  });

  it("findJob locates by docket id", () => {
    const q = enq(emptyQueue(), job(7, "did:a"));
    expect(findJob(q, 7)?.requesterDid).toBe("did:a");
    expect(findJob(q, 999)).toBeUndefined();
  });

  it("markFailed flips status and frees the docket for re-queue", () => {
    let q = enq(emptyQueue(), job(1, "did:a"));
    q = markFailed(q, 1);
    expect(findJob(q, 1)?.status).toBe("failed");
    expect(nextQueued(q)).toBeUndefined();
    expect(enqueue(q, job(1, "did:b"), { perRequesterCap: 3 }).ok).toBe(true);
  });
});

describe("persistence", () => {
  it("round-trips jobs + seen through save/load; missing file = empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rcape-queue-"));
    try {
      const path = join(dir, "queue.json");
      let q = enq(emptyQueue(), job(1, "did:a"));
      q = markSeen(q, "at://seen1");
      await saveQueue(path, q);
      const loaded = await loadQueue(path);
      expect(loaded.jobs[0]?.docketId).toBe(1);
      expect(loaded.seen).toContain("at://seen1");
      expect(await loadQueue(join(dir, "nope.json"))).toEqual(emptyQueue());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("seen set", () => {
  it("dedupes processed notification URIs", () => {
    let q = emptyQueue();
    expect(hasSeen(q, "at://x")).toBe(false);
    q = markSeen(q, "at://x");
    expect(hasSeen(q, "at://x")).toBe(true);
    // idempotent
    expect(markSeen(q, "at://x")).toBe(q);
  });

  it("stays bounded", () => {
    let q = emptyQueue();
    for (let i = 0; i < 1200; i++) q = markSeen(q, `at://n${i}`);
    expect(q.seen.length).toBeLessThanOrEqual(1000);
    // the most recent survive
    expect(hasSeen(q, "at://n1199")).toBe(true);
    expect(hasSeen(q, "at://n0")).toBe(false);
  });
});
