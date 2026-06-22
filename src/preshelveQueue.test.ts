import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type PreshelveJob,
  emptyPreshelveQueue,
  enqueuePreshelve,
  findPreshelveJob,
  loadPreshelveQueue,
  markPreshelveDone,
  markPreshelveFailed,
  mutatePreshelveQueue,
  nextPendingPreshelve,
  pendingPreshelve,
} from "./preshelveQueue.js";

const job = (over: Partial<PreshelveJob> = {}): PreshelveJob => ({
  docketId: 1,
  source: "did:plc:src",
  discoveredAt: "2026-06-22T10:00:00.000Z",
  status: "pending",
  ...over,
});

describe("preshelveQueue pure ops", () => {
  it("enqueues and dedups by docketId across any status", () => {
    let q = emptyPreshelveQueue();
    q = enqueuePreshelve(q, job({ docketId: 1 }));
    q = enqueuePreshelve(q, job({ docketId: 2 }));
    expect(q.jobs).toHaveLength(2);
    // Same docket again → no-op even though the first is pending.
    q = enqueuePreshelve(q, job({ docketId: 1, source: "other" }));
    expect(q.jobs).toHaveLength(2);
    // Even after it's done, it is NOT re-queued (no thrash).
    q = markPreshelveDone(q, 1);
    q = enqueuePreshelve(q, job({ docketId: 1 }));
    expect(q.jobs).toHaveLength(2);
    expect(findPreshelveJob(q, 1)?.status).toBe("done");
  });

  it("nextPendingPreshelve returns the oldest pending, skipping done/failed", () => {
    let q = emptyPreshelveQueue();
    q = enqueuePreshelve(
      q,
      job({ docketId: 1, discoveredAt: "2026-06-22T09:00:00.000Z" }),
    );
    q = enqueuePreshelve(
      q,
      job({ docketId: 2, discoveredAt: "2026-06-22T08:00:00.000Z" }),
    );
    q = enqueuePreshelve(
      q,
      job({ docketId: 3, discoveredAt: "2026-06-22T07:00:00.000Z" }),
    );
    q = markPreshelveDone(q, 3); // oldest, but done → skipped
    expect(nextPendingPreshelve(q)?.docketId).toBe(2); // next-oldest pending
    expect(
      pendingPreshelve(q)
        .map((j) => j.docketId)
        .sort(),
    ).toEqual([1, 2]);
  });

  it("markPreshelveFailed/Done flip only the named docket", () => {
    let q = emptyPreshelveQueue();
    q = enqueuePreshelve(q, job({ docketId: 1 }));
    q = enqueuePreshelve(q, job({ docketId: 2 }));
    q = markPreshelveFailed(q, 1);
    expect(findPreshelveJob(q, 1)?.status).toBe("failed");
    expect(findPreshelveJob(q, 2)?.status).toBe("pending");
  });
});

describe("preshelveQueue persistence", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "rcape-preshelve-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips through load/mutate", async () => {
    const path = join(dir, "preshelve-queue.json");
    await mutatePreshelveQueue(path, (q) =>
      enqueuePreshelve(q, job({ docketId: 42 })),
    );
    const loaded = await loadPreshelveQueue(path);
    expect(loaded.jobs).toHaveLength(1);
    expect(loaded.jobs[0]?.docketId).toBe(42);
  });

  it("loads an empty queue when the file is absent", async () => {
    const loaded = await loadPreshelveQueue(join(dir, "nope.json"));
    expect(loaded).toEqual(emptyPreshelveQueue());
  });
});
