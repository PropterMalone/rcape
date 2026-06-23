import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaseRepo } from "./caseRepo.js";
import { type CourtListenerClient, ThrottledError } from "./courtlistener.js";
import type { ClDocket, ClDocketEntry } from "./courtlistener.types.js";
import {
  type CaseEntry,
  chargeQuota,
  emptyLedger,
  loadLedger,
  recordCase,
  saveLedger,
  tokenId,
} from "./ledger.js";
import { monitorOnce, selectDueCases } from "./monitor.js";
import type { ProvisionConfig } from "./provisionCase.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rcape-monitor-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const OLD = "2026-01-01T00:00:00.000Z"; // older than any cadence
const NOW = Date.parse("2026-06-17T12:00:00.000Z");
const NOW_ISO = new Date(NOW).toISOString();
const DAY = NOW_ISO.slice(0, 10);
const INTERVAL = 3 * 24 * 60 * 60 * 1000;

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

const completedCase = (over: Partial<CaseEntry> = {}): CaseEntry => ({
  did: "did:case",
  handle: "doe.rcape.org",
  password: "pw",
  createdAt: OLD,
  completed: true,
  highWater: "2025-01-05.001",
  lastCheckedAt: OLD,
  ...over,
});

const docket = {
  id: 123,
  absolute_url: "/docket/123/doe-v-roe/",
  case_name: "Doe v. Roe",
  court_id: "nysd",
  docket_number: "1:23-cv-1",
} as unknown as ClDocket;

const entry = (seq: string, id: number): ClDocketEntry =>
  ({
    id,
    entry_number: id,
    recap_sequence_number: seq,
    date_filed: "2025-02-01",
    description: "new filing",
    recap_documents: [],
  }) as unknown as ClDocketEntry;

function clientStub(over: Record<string, unknown> = {}): CourtListenerClient {
  return {
    requestCount: 2,
    fetchDocketEntriesSince: async () => [],
    getDocket: async () => docket,
    ...over,
  } as unknown as CourtListenerClient;
}

function repoStub() {
  const created: Array<{ collection: string; rkey: string }> = [];
  const repo = {
    applyCreates: async (rows: Array<{ collection: string; rkey: string }>) => {
      created.push(...rows);
    },
    createRecord: async () => ({ uri: "at://x", cid: "c" }),
    putRecord: async () => ({}),
  } as unknown as CaseRepo;
  return { repo, created };
}

describe("selectDueCases", () => {
  it("returns completed cases due by interval, oldest-checked first, capped", () => {
    let l = emptyLedger();
    l = recordCase(
      l,
      1,
      completedCase({ lastCheckedAt: "2026-06-16T12:00:00Z" }),
    ); // recent
    l = recordCase(l, 2, completedCase({ lastCheckedAt: OLD })); // due, oldest
    l = recordCase(
      l,
      3,
      completedCase({ lastCheckedAt: "2026-05-01T00:00:00Z" }),
    ); // due
    expect(selectDueCases(l, NOW, INTERVAL, 5).map((d) => d.docketId)).toEqual([
      2, 3,
    ]);
    expect(selectDueCases(l, NOW, INTERVAL, 1).map((d) => d.docketId)).toEqual([
      2,
    ]); // cap
  });

  it("skips non-completed cases and cases with no high-water", () => {
    let l = emptyLedger();
    l = recordCase(l, 1, completedCase({ completed: false }));
    l = recordCase(l, 2, completedCase({ highWater: undefined }));
    expect(selectDueCases(l, NOW, 1000, 5)).toEqual([]);
  });

  it("uses createdAt for a never-checked case, so a fresh provision isn't due yet", () => {
    const l = recordCase(emptyLedger(), 1, {
      ...completedCase({ lastCheckedAt: undefined }),
      createdAt: new Date(NOW - 1000).toISOString(), // just provisioned
    });
    expect(selectDueCases(l, NOW, INTERVAL, 5)).toEqual([]);
  });
});

describe("monitorOnce", () => {
  const seed = async (over: Partial<CaseEntry> = {}, charge = 0) => {
    const ledgerPath = join(dir, "ledger.json");
    let l = recordCase(emptyLedger(), 123, completedCase(over));
    if (charge) l = chargeQuota(l, charge, DAY, "t");
    await saveLedger(ledgerPath, l);
    return ledgerPath;
  };

  it("no-ops when nothing is due", async () => {
    const ledgerPath = await seed({ lastCheckedAt: NOW_ISO });
    const r = await monitorOnce({ cfg: cfg(ledgerPath) }, { now: () => NOW });
    expect(r).toEqual({ checked: 0, updated: 0 });
  });

  it("a due case with no new filings: stamps lastCheckedAt, never logs in to post", async () => {
    const ledgerPath = await seed();
    const fetchSince = vi.fn(async () => []);
    const loginRepo = vi.fn();
    const r = await monitorOnce(
      { cfg: cfg(ledgerPath) },
      {
        now: () => NOW,
        makeClient: () =>
          clientStub({ requestCount: 1, fetchDocketEntriesSince: fetchSince }),
        loginRepo: loginRepo as never,
      },
    );
    expect(r).toEqual({ checked: 1, updated: 0 });
    expect(fetchSince).toHaveBeenCalledWith(123, "2025-01-05.001"); // since high-water
    expect(loginRepo).not.toHaveBeenCalled(); // no posting when nothing new
    const l = await loadLedger(ledgerPath);
    expect(l.cases["123"]?.lastCheckedAt).toBe(NOW_ISO);
    expect(l.cases["123"]?.highWater).toBe("2025-01-05.001"); // unchanged
  });

  it("appends new filings, advances high-water, and stamps the check", async () => {
    const ledgerPath = await seed({ filings: 5 });
    const { repo, created } = repoStub();
    const loginRepo = vi.fn(async () => repo);
    const r = await monitorOnce(
      { cfg: cfg(ledgerPath) },
      {
        now: () => NOW,
        makeClient: () =>
          clientStub({
            requestCount: 3,
            // newest-first, as the DESC fetch returns
            fetchDocketEntriesSince: async () => [
              entry("2025-03-02.001", 10),
              entry("2025-03-01.001", 9),
            ],
          }),
        loginRepo,
      },
    );
    expect(r).toEqual({ checked: 1, updated: 1 });
    expect(loginRepo).toHaveBeenCalledOnce();
    expect(created).toHaveLength(2); // both new entries applyCreated
    const l = await loadLedger(ledgerPath);
    expect(l.cases["123"]?.highWater).toBe("2025-03-02.001"); // newest posted
    expect(l.cases["123"]?.lastCheckedAt).toBe(NOW_ISO);
    expect(l.cases["123"]?.password).toBe("pw"); // partial merge preserved creds
    // filings bumped by the 2 posted entries (5 prior + 2) so the directory count
    // stays current — previously left stale at the provision-time value.
    expect(l.cases["123"]?.filings).toBe(7);
    // reconcileMonitor wrote the 3 actual calls into the rolling 24h log — if
    // recordCalls were dropped from the reconcile the predictive gate would stay
    // empty with no failing test (the pre-fix freeze). This asserts write-through.
    expect(l.calls?.[tokenId("t")]?.length ?? 0).toBe(3);
  });

  it("budget gate: does not fetch when a token lacks headroom beyond provisioning", async () => {
    const ledgerPath = await seed({}, 120); // 5 left < 12+5 floor
    const fetchSince = vi.fn();
    const r = await monitorOnce(
      { cfg: cfg(ledgerPath) },
      {
        now: () => NOW,
        makeClient: () => clientStub({ fetchDocketEntriesSince: fetchSince }),
      },
    );
    expect(fetchSince).not.toHaveBeenCalled();
    expect(r).toEqual({ checked: 0, updated: 0 });
  });

  it("stops the cycle on a throttle (leaves the case for a later cycle)", async () => {
    const ledgerPath = await seed();
    const r = await monitorOnce(
      { cfg: cfg(ledgerPath) },
      {
        now: () => NOW,
        makeClient: () =>
          clientStub({
            requestCount: 1,
            fetchDocketEntriesSince: async () => {
              throw new ThrottledError(5000);
            },
          }),
      },
    );
    expect(r).toEqual({ checked: 0, updated: 0 });
    const l = await loadLedger(ledgerPath);
    expect(l.cases["123"]?.lastCheckedAt).toBe(OLD); // untouched → retried later
  });

  it("guards a login/post failure: stamps checked, never rethrows, never logs the password", async () => {
    const ledgerPath = await seed();
    // A PDS auth failure whose message echoes the case password — exactly what the
    // drain path already refuses to log. The monitor must mirror that.
    const loginRepo = vi.fn(async () => {
      throw new Error("auth failed for did:case with password=pw");
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const r = await monitorOnce(
        { cfg: cfg(ledgerPath) },
        {
          now: () => NOW,
          makeClient: () =>
            clientStub({
              requestCount: 3,
              fetchDocketEntriesSince: async () => [
                entry("2025-03-02.001", 10),
              ],
            }),
          loginRepo,
        },
      );
      // Did NOT throw out of the loop; the case is counted checked (so a persistent
      // auth fault doesn't re-hammer every cadence), but high-water is untouched so
      // the new filing retries next cadence.
      expect(r).toEqual({ checked: 1, updated: 0 });
      const l = await loadLedger(ledgerPath);
      expect(l.cases["123"]?.lastCheckedAt).toBe(NOW_ISO); // stamped
      expect(l.cases["123"]?.highWater).toBe("2025-01-05.001"); // unchanged
      // No console.error line carries the password (or the raw message).
      const logged = errSpy.mock.calls.flat().join(" ");
      expect(logged).toContain("123"); // docketId is logged
      expect(logged).not.toContain("pw"); // credential is NOT
      expect(logged).not.toContain("password=");
    } finally {
      errSpy.mockRestore();
    }
  });
});
