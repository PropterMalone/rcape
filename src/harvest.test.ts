import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveJson } from "./atomicJson.js";
import {
  type HarvestDeps,
  harvestOnce,
  msUntilUtcMidnight,
  preshelveDrainOnce,
} from "./harvest.js";
import {
  type Ledger,
  chargeQuota,
  emptyLedger,
  loadLedger,
  saveLedger,
} from "./ledger.js";
import {
  type PreshelveJob,
  emptyPreshelveQueue,
  loadPreshelveQueue,
  savePreshelveQueue,
} from "./preshelveQueue.js";
import type { ProvisionConfig, ProvisionResult } from "./provisionCase.js";

const DOCKET_URL = (id: number) =>
  `https://www.courtlistener.com/docket/${id}/x/`;

const NOW_IN = Date.parse("2026-06-22T23:00:00.000Z"); // 1h before UTC midnight → in window
const NOW_OUT = Date.parse("2026-06-22T12:00:00.000Z"); // midday → outside window
const DAY = "2026-06-22";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rcape-harvest-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function cfg(ledgerPath: string): ProvisionConfig {
  return {
    tokens: ["t"],
    domain: "rcape.org",
    hashN: 0,
    adminPassword: "",
    cfToken: "",
    zoneId: "",
    ledgerPath,
  };
}

const okResult: ProvisionResult = {
  status: "provisioned",
  handle: "case.rcape.org",
  did: "did:new",
  caseName: "X v. Y",
  published: 3,
  failed: 0,
};

function paths() {
  return {
    ledgerPath: join(dir, "ledger.json"),
    queuePath: join(dir, "queue.json"),
    preshelveQueuePath: join(dir, "preshelve-queue.json"),
  };
}

function feedAgent(items: { text?: string; links?: string[] }[]) {
  return {
    getAuthorFeed: vi.fn(async () => ({
      items: items.map((i) => ({
        attributedDid: "did:src",
        links: i.links ?? [],
        text: i.text,
      })),
    })),
    createRecord: vi.fn(async () => ({ uri: "at://x", cid: "c" })),
  };
}

function deps(
  agent: ReturnType<typeof feedAgent>,
  provision: ReturnType<typeof vi.fn>,
  over: Partial<HarvestDeps["harvest"]> = {},
): HarvestDeps {
  const p = paths();
  return {
    agent,
    cfg: cfg(p.ledgerPath),
    preshelveQueuePath: p.preshelveQueuePath,
    queuePath: p.queuePath,
    provision,
    harvest: { accounts: ["did:src"], ...over },
  };
}

async function writeLedger(mutate: (l: Ledger) => Ledger = (l) => l) {
  await saveLedger(paths().ledgerPath, mutate(emptyLedger()));
}

describe("msUntilUtcMidnight", () => {
  it("computes time to the next UTC midnight", () => {
    expect(msUntilUtcMidnight(NOW_IN)).toBe(60 * 60 * 1000);
    expect(msUntilUtcMidnight(NOW_OUT)).toBe(12 * 60 * 60 * 1000);
  });
});

describe("harvestOnce", () => {
  it("is a no-op with no configured accounts", async () => {
    await writeLedger();
    const agent = feedAgent([{ links: [DOCKET_URL(1)] }]);
    const d = deps(agent, vi.fn(), { accounts: [] });
    const got = await harvestOnce(d, { now: () => NOW_OUT });
    expect(got.harvested).toBe(0);
    expect(agent.getAuthorFeed).not.toHaveBeenCalled();
  });

  it("enqueues new dockets, skips already-shelved, stamps sweptAt", async () => {
    await writeLedger((l) => ({
      ...l,
      cases: {
        "1": {
          did: "d",
          handle: "h",
          password: "p",
          createdAt: "",
          completed: true,
        },
      },
    }));
    const agent = feedAgent([
      { links: [DOCKET_URL(1)] }, // already shelved → skip
      { links: [DOCKET_URL(2)] },
      { text: `see ${DOCKET_URL(3)}` },
      { text: "no docket here" },
    ]);
    const d = deps(agent, vi.fn());
    const got = await harvestOnce(d, { now: () => NOW_OUT });
    expect(got.harvested).toBe(2); // 2 and 3, not 1 (shelved) or the linkless post
    const pq = await loadPreshelveQueue(paths().preshelveQueuePath);
    expect(pq.jobs.map((j) => j.docketId).sort()).toEqual([2, 3]);
    const ledger = await loadLedger(paths().ledgerPath);
    expect(ledger.harvest?.sweptAt).toBe(new Date(NOW_OUT).toISOString());
  });

  it("respects the cadence interval (no re-read within the interval)", async () => {
    await writeLedger((l) => ({
      ...l,
      harvest: { sweptAt: new Date(NOW_OUT - 1000).toISOString() },
    }));
    const agent = feedAgent([{ links: [DOCKET_URL(5)] }]);
    const d = deps(agent, vi.fn(), {
      accounts: ["did:src"],
      intervalMs: 60_000,
    });
    const got = await harvestOnce(d, { now: () => NOW_OUT });
    expect(got.harvested).toBe(0);
    expect(agent.getAuthorFeed).not.toHaveBeenCalled();
  });

  it("does not re-enqueue a docket already in the by-request queue", async () => {
    await writeLedger();
    await saveJson(paths().queuePath, {
      jobs: [{ docketId: 7, status: "queued", createdAt: "" }],
      seen: [],
    });
    const agent = feedAgent([{ links: [DOCKET_URL(7)] }]);
    const got = await harvestOnce(deps(agent, vi.fn()), { now: () => NOW_OUT });
    expect(got.harvested).toBe(0);
  });
});

const pendingJob = (
  docketId: number,
  over: Partial<PreshelveJob> = {},
): PreshelveJob => ({
  docketId,
  source: "did:src",
  discoveredAt: "2026-06-22T10:00:00.000Z",
  status: "pending",
  ...over,
});

async function seedPreshelve(...jobs: PreshelveJob[]) {
  await savePreshelveQueue(paths().preshelveQueuePath, {
    ...emptyPreshelveQueue(),
    jobs,
  });
}

describe("preshelveDrainOnce", () => {
  it("does nothing outside the near-reset window", async () => {
    await writeLedger();
    await seedPreshelve(pendingJob(1));
    const provision = vi.fn(async () => okResult);
    const got = await preshelveDrainOnce(deps(feedAgent([]), provision), {
      now: () => NOW_OUT,
    });
    expect(got.provisioned).toBe(0);
    expect(provision).not.toHaveBeenCalled();
  });

  it("drains pending jobs inside the window with spare quota, and announces", async () => {
    await writeLedger();
    await seedPreshelve(pendingJob(1), pendingJob(2));
    const agent = feedAgent([]);
    const provision = vi.fn(async () => okResult);
    const got = await preshelveDrainOnce(deps(agent, provision), {
      now: () => NOW_IN,
    });
    expect(got.provisioned).toBe(2);
    expect(provision).toHaveBeenCalledTimes(2);
    expect(agent.createRecord).toHaveBeenCalledTimes(2); // announced each
    const pq = await loadPreshelveQueue(paths().preshelveQueuePath);
    expect(pq.jobs.every((j) => j.status === "done")).toBe(true);
  });

  it("honors maxPerDrain", async () => {
    await writeLedger();
    await seedPreshelve(pendingJob(1), pendingJob(2), pendingJob(3));
    const provision = vi.fn(async () => okResult);
    const got = await preshelveDrainOnce(
      deps(feedAgent([]), provision, { accounts: ["did:src"], maxPerDrain: 1 }),
      { now: () => NOW_IN },
    );
    expect(got.provisioned).toBe(1);
    expect(provision).toHaveBeenCalledTimes(1);
  });

  it("skips when a by-request job is drainable (must not compete)", async () => {
    await writeLedger();
    await seedPreshelve(pendingJob(1));
    await saveJson(paths().queuePath, {
      jobs: [{ docketId: 99, status: "queued", createdAt: "" }],
      seen: [],
    });
    const provision = vi.fn(async () => okResult);
    const got = await preshelveDrainOnce(deps(feedAgent([]), provision), {
      now: () => NOW_IN,
    });
    expect(got.provisioned).toBe(0);
    expect(provision).not.toHaveBeenCalled();
  });

  it("does not provision when no token clears the high floor", async () => {
    await writeLedger((l) => chargeQuota(l, 125 - 50, DAY, "t")); // 50 left < floor 60
    await seedPreshelve(pendingJob(1));
    const provision = vi.fn(async () => okResult);
    const got = await preshelveDrainOnce(deps(feedAgent([]), provision), {
      now: () => NOW_IN,
    });
    expect(got.provisioned).toBe(0);
    expect(provision).not.toHaveBeenCalled();
  });

  it("marks an already-shelved pending job done without provisioning", async () => {
    await writeLedger((l) => ({
      ...l,
      cases: {
        "1": {
          did: "d",
          handle: "h",
          password: "p",
          createdAt: "",
          completed: true,
        },
      },
    }));
    await seedPreshelve(pendingJob(1));
    const provision = vi.fn(async () => okResult);
    const got = await preshelveDrainOnce(deps(feedAgent([]), provision), {
      now: () => NOW_IN,
    });
    expect(got.provisioned).toBe(0);
    expect(provision).not.toHaveBeenCalled();
    const pq = await loadPreshelveQueue(paths().preshelveQueuePath);
    expect(pq.jobs[0]?.status).toBe("done");
  });
});
