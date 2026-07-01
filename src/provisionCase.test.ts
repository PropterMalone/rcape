import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MappedCase } from "./build.js";
import {
  type FetchCheckpoint,
  loadCheckpoint,
  saveCheckpoint,
} from "./caseCache.js";
import type { CaseRepo } from "./caseRepo.js";
import { type CourtListenerClient, ThrottledError } from "./courtlistener.js";
import {
  type CaseEntry,
  emptyLedger,
  findCase,
  loadLedger,
  recordCase,
  saveLedger,
  tokenId,
} from "./ledger.js";
import {
  type ProvisionConfig,
  announceProvisioned,
  postedHighWater,
  provisionMode,
  runProvision,
} from "./provisionCase.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rcape-provision-"));
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

// A client stub that only reports a fixed requestCount — the single field
// runProvision reads for quota accounting.
function clientWithCount(n: number): CourtListenerClient {
  return { requestCount: n } as unknown as CourtListenerClient;
}

const DAY = new Date().toISOString().slice(0, 10);

describe("runProvision incremental quota", () => {
  it("persists the reservation BEFORE fetch resolves, so a true crash mid-fetch still shows spend", async () => {
    const ledgerPath = join(dir, "ledger.json");
    await saveLedger(ledgerPath, emptyLedger());

    const SPENT = 9; // calls CL already counted at the crash point
    // Observe the durable ledger AT the moment the fetch is in flight (before it
    // resolves or rejects, i.e. before any catch-reconcile could run). A true
    // process crash here would persist whatever was already on disk. The old
    // code charged nothing until after fetchAndMapCase resolved, so this read
    // would have seen 0; the reservation makes it >= the calls already spent.
    let durableAtCrash = -1;
    const result = await runProvision(123, cfg(ledgerPath), {
      makeClient: () => clientWithCount(SPENT),
      mapCase: async () => {
        durableAtCrash =
          (await loadLedger(ledgerPath)).quota.counts[tokenId("t")] ?? 0;
        throw new Error("simulated crash mid-fetch");
      },
    });
    expect(result.status).toBe("error");

    // The reservation was on disk while the fetch was running — not 0.
    expect(durableAtCrash).toBeGreaterThanOrEqual(SPENT);

    // After the catch reconciles, the durable counter reflects the real spend.
    const ledger = await loadLedger(ledgerPath);
    expect(ledger.quota.day).toBe(DAY);
    expect(ledger.quota.counts[tokenId("t")] ?? 0).toBeGreaterThanOrEqual(
      SPENT,
    );
  });

  it("classifies a mid-fetch ThrottledError as throttled (not a fault) and reconciles spend", async () => {
    const ledgerPath = join(dir, "ledger.json");
    await saveLedger(ledgerPath, emptyLedger());

    const SPENT = 7; // calls made before the hourly window closed
    const result = await runProvision(123, cfg(ledgerPath), {
      makeClient: () => clientWithCount(SPENT),
      mapCase: async () => {
        throw new ThrottledError(800_000);
      },
    });
    expect(result).toEqual({
      status: "throttled",
      retryAfterMs: 800_000,
      token: "t",
    });

    // The reservation reconciled to the real spend — no quota leak on a throttle.
    const ledger = await loadLedger(ledgerPath);
    expect(ledger.quota.counts[tokenId("t")] ?? 0).toBe(SPENT);
  });

  it("reconciles down to the real call count on a successful fetch", async () => {
    const ledgerPath = join(dir, "ledger.json");
    await saveLedger(ledgerPath, emptyLedger());

    const ACTUAL = 13;
    // mapCase resolves with the minimum shape recordCase/handle derivation need,
    // then dry-run short-circuits before any account/DNS/repo I/O.
    const result = await runProvision(123, cfg(ledgerPath), {
      dryRun: true,
      makeClient: () => clientWithCount(ACTUAL),
      // Minimal shape: only caseName/docketNumber (handle derivation) and the
      // empty record arrays (dry-run counts) are read before the short-circuit.
      mapCase: async () =>
        ({
          docketRecord: { caseName: "Doe v. Roe", docketNumber: "1:23-cv-1" },
          entryRecords: [],
          parties: [],
          records: [],
        }) as unknown as MappedCase,
    });
    expect(result.status).toBe("dry-run");

    const ledger = await loadLedger(ledgerPath);
    // Reservation (17) reconciled down to the actual 13 calls.
    expect(ledger.quota.counts[tokenId("t")] ?? 0).toBe(ACTUAL);
    // The rolling 24h log also reflects the ACTUAL calls — if recordCalls were
    // dropped from reconcileQuota the predictive gate would silently stay empty
    // (the pre-fix freeze), with no failing test. This is that test.
    expect(ledger.calls?.[tokenId("t")]?.length ?? 0).toBe(ACTUAL);
  });

  it("applies the rolling-window gate at token selection: a rolling-full token returns quota-exhausted with no CL call", async () => {
    const ledgerPath = join(dir, "ledger.json");
    // Calendar quota untouched (0 spent today) so the ONLY blocker is the rolling
    // 24h window: 125 calls in the last 24h leave < RESERVED_CALLS_PER_CASE free.
    // Without nowMs at the provision selectToken, this would slip through and burn
    // a CL request into an already-spent window (the 2026-06-17 freeze pattern).
    const now = Date.now();
    const recent = Array.from(
      { length: 125 },
      (_, i) => now - i * 600_000, // spread over the last ~20.8h, all in-window
    );
    await saveLedger(ledgerPath, {
      ...emptyLedger(),
      calls: { [tokenId("t")]: recent },
    });

    let clientMade = false;
    const result = await runProvision(123, cfg(ledgerPath), {
      makeClient: () => {
        clientMade = true;
        return clientWithCount(0);
      },
    });

    expect(result.status).toBe("quota-exhausted");
    expect(clientMade).toBe(false); // no CL client ever constructed → no call
  });
});

describe("runProvision fetch cache", () => {
  const sampleMapCase = () =>
    vi.fn(
      async () =>
        ({
          docketRecord: { caseName: "Doe v. Roe", docketNumber: "1:23-cv-1" },
          entryRecords: [],
          parties: [],
          records: [],
        }) as unknown as MappedCase,
    );

  it("reuses a cached fetch on the next provision — no second CL fetch, no extra quota", async () => {
    const ledgerPath = join(dir, "ledger.json");
    await saveLedger(ledgerPath, emptyLedger());
    const c = { ...cfg(ledgerPath), cacheDir: join(dir, "cache") };
    const mapCase = sampleMapCase();

    const first = await runProvision(123, c, {
      dryRun: true,
      makeClient: () => clientWithCount(8),
      mapCase: mapCase as never,
    });
    expect(first.status).toBe("dry-run");
    expect(mapCase).toHaveBeenCalledTimes(1);
    expect((await loadLedger(ledgerPath)).quota.counts[tokenId("t")] ?? 0).toBe(
      8,
    );

    // Same docket again: served from cache. The client would charge 99 calls if a
    // fetch happened — proving the second run made none.
    const second = await runProvision(123, c, {
      dryRun: true,
      makeClient: () => clientWithCount(99),
      mapCase: mapCase as never,
    });
    expect(second.status).toBe("dry-run");
    expect(mapCase).toHaveBeenCalledTimes(1); // not re-fetched
    expect((await loadLedger(ledgerPath)).quota.counts[tokenId("t")] ?? 0).toBe(
      8, // unchanged — no fetch, no charge
    );
  });

  it("re-fetches every time when no cacheDir is set (caching is opt-in)", async () => {
    const ledgerPath = join(dir, "ledger.json");
    await saveLedger(ledgerPath, emptyLedger());
    const mapCase = sampleMapCase();
    // 2 calls/cycle keeps both runs under the 5/min rolling window so the second
    // provision is gated only by the (absent) cache, not the rolling-window gate
    // now applied at token selection.
    for (let i = 0; i < 2; i++) {
      await runProvision(123, cfg(ledgerPath), {
        dryRun: true,
        makeClient: () => clientWithCount(2),
        mapCase: mapCase as never,
      });
    }
    expect(mapCase).toHaveBeenCalledTimes(2);
  });
});

describe("runProvision checkpoint resume", () => {
  const minimalMapped = () =>
    ({
      docketRecord: { caseName: "Doe v. Roe", docketNumber: "1:23-cv-1" },
      entryRecords: [],
      parties: [],
      records: [],
    }) as unknown as MappedCase;

  const partial = (): FetchCheckpoint => ({
    savedAt: "2026-06-17T18:00:00.000Z",
    docket: { id: 123 } as unknown as FetchCheckpoint["docket"],
    entries: [{ id: 1 } as unknown as FetchCheckpoint["entries"][number]],
    entriesNext: "CURSOR2",
    entriesStarted: true,
    parties: [],
    partiesNext: null,
    partiesStarted: false,
  });

  it("persists a checkpoint on throttle, then resumes it to completion + clears it; quota sums per window", async () => {
    const ledgerPath = join(dir, "ledger.json");
    const cacheDir = join(dir, "cache");
    await saveLedger(ledgerPath, emptyLedger());
    const c = { ...cfg(ledgerPath), cacheDir };

    // Window 1: persist progress via onProgress, then throttle.
    const r1 = await runProvision(123, c, {
      makeClient: () => clientWithCount(3),
      mapCase: async (_o, _client, resume) => {
        await resume?.onProgress?.(partial());
        throw new ThrottledError(5000);
      },
    });
    expect(r1.status).toBe("throttled");
    expect(await loadCheckpoint(cacheDir, 123, Date.now())).toBeDefined();

    // Window 2: the resumed checkpoint reaches mapCase; it completes.
    let received: FetchCheckpoint | undefined;
    const r2 = await runProvision(123, c, {
      dryRun: true,
      makeClient: () => clientWithCount(2),
      mapCase: async (_o, _client, resume) => {
        received = resume?.checkpoint;
        return minimalMapped();
      },
    });
    expect(r2.status).toBe("dry-run");
    expect(received?.entriesNext).toBe("CURSOR2"); // resumed, not page 1
    // Checkpoint cleared on success.
    expect(await loadCheckpoint(cacheDir, 123, Date.now())).toBeUndefined();
    // Quota = each window's actual calls (3 + 2), not 10+10 reservations.
    expect((await loadLedger(ledgerPath)).quota.counts[tokenId("t")] ?? 0).toBe(
      5,
    );
  });

  it("clears the checkpoint when the docket 404s on resume", async () => {
    const ledgerPath = join(dir, "ledger.json");
    const cacheDir = join(dir, "cache");
    await saveLedger(ledgerPath, emptyLedger());
    await saveCheckpoint(cacheDir, 123, partial(), new Date().toISOString());

    const r = await runProvision(
      123,
      { ...cfg(ledgerPath), cacheDir },
      {
        makeClient: () => clientWithCount(1),
        mapCase: async () => {
          throw new Error("CourtListener 404: docket not found");
        },
      },
    );
    expect(r.status).toBe("not-found");
    expect(await loadCheckpoint(cacheDir, 123, Date.now())).toBeUndefined();
  });

  it("passes no resume arg when cacheDir is unset (regression)", async () => {
    const ledgerPath = join(dir, "ledger.json");
    await saveLedger(ledgerPath, emptyLedger());
    let resumeArg: unknown = "sentinel";
    await runProvision(123, cfg(ledgerPath), {
      dryRun: true,
      makeClient: () => clientWithCount(1),
      mapCase: async (_o, _client, resume) => {
        resumeArg = resume;
        return minimalMapped();
      },
    });
    expect(resumeArg).toBeUndefined();
  });
});

function mockRepo(overrides: Partial<Record<string, unknown>> = {}): CaseRepo {
  return {
    did: "did:plc:zombie",
    handle: "zombie.rcape.org",
    applyCreates: vi.fn(async () => {}),
    // Pretend each queried collection has one leftover record, so a resume
    // exercises the reset (applyDeletes) path.
    collect: vi.fn(async () => [{ rkey: "old1", uri: "", cid: "", value: {} }]),
    applyDeletes: vi.fn(async () => {}),
    ...overrides,
  } as unknown as CaseRepo;
}

describe("provisionMode", () => {
  const entry = (over: Partial<CaseEntry> = {}): CaseEntry => ({
    did: "d",
    handle: "h",
    password: "p",
    createdAt: "x",
    ...over,
  });
  it("is fresh when there is no existing entry", () => {
    expect(provisionMode(undefined, false).kind).toBe("fresh");
  });
  it("is exists when the entry is completed and --force is not set", () => {
    expect(provisionMode(entry({ completed: true }), false).kind).toBe(
      "exists",
    );
  });
  it("is force-mint when the entry is completed and --force is set", () => {
    expect(provisionMode(entry({ completed: true }), true).kind).toBe(
      "force-mint",
    );
  });
  it("is resume for a present-but-incomplete entry (crash zombie), regardless of --force", () => {
    expect(provisionMode(entry(), false).kind).toBe("resume");
    expect(provisionMode(entry(), true).kind).toBe("resume");
  });
});

describe("runProvision dedupe / resume", () => {
  it("dedupes a completed entry without re-fetching the case", async () => {
    const ledgerPath = join(dir, "ledger.json");
    await saveLedger(
      ledgerPath,
      recordCase(emptyLedger(), 123, {
        did: "did:plc:done",
        handle: "done.rcape.org",
        password: "pw",
        createdAt: DAY,
        completed: true,
      }),
    );
    const mapCase = vi.fn();
    const result = await runProvision(123, cfg(ledgerPath), {
      makeClient: () => clientWithCount(0),
      mapCase: mapCase as never,
    });
    expect(result.status).toBe("exists");
    if (result.status === "exists")
      expect(result.handle).toBe("done.rcape.org");
    // The whole point: a completed entry never re-fetches or re-mints.
    expect(mapCase).not.toHaveBeenCalled();
  });

  it("resumes a crash-incomplete (zombie) entry rather than reporting it provisioned", async () => {
    const ledgerPath = join(dir, "ledger.json");
    // Credentials persisted early, but no `completed` flag: the crash hit before
    // DNS/records/backfill finished. The OLD code returned `exists` here.
    await saveLedger(
      ledgerPath,
      recordCase(emptyLedger(), 123, {
        did: "did:plc:zombie",
        handle: "zombie.rcape.org",
        password: "pw-z",
        createdAt: DAY,
      }),
    );

    const repo = mockRepo();
    const makeAccount = vi.fn();
    let loginArgs: { identifier?: string; password?: string } | undefined;
    const result = await runProvision(123, cfg(ledgerPath), {
      makeClient: () => clientWithCount(17),
      mapCase: async () =>
        ({
          docketRecord: { caseName: "Doe v. Roe", docketNumber: "1:23-cv-1" },
          entryRecords: [],
          parties: [],
          records: [
            {
              collection: "org.rcape.docketEntry",
              rkey: "e1",
              record: { recapSequenceNumber: "001" },
            },
          ],
        }) as unknown as MappedCase,
      makeAccount: makeAccount as never,
      upsertDns: (async () => ({ created: false })) as never,
      loginRepo: (async (o: { identifier: string; password: string }) => {
        loginArgs = o;
        return repo;
      }) as never,
      backfill: async () => ({ published: 1, failed: [] }),
    });

    expect(result.status).toBe("provisioned");
    // Reused the stored handle — did NOT mint a fresh account.
    if (result.status === "provisioned") {
      expect(result.handle).toBe("zombie.rcape.org");
    }
    expect(makeAccount).not.toHaveBeenCalled();
    // Logged in with the ZOMBIE's stored credentials (not a fresh mint) — a
    // resume that used the wrong identity would fail loudly in prod but this
    // pins the intent.
    expect(loginArgs).toMatchObject({
      identifier: "did:plc:zombie",
      password: "pw-z",
    });
    // Reset the half-written repo (deleted leftovers) then rebuilt it.
    expect(repo.applyDeletes).toHaveBeenCalled();
    expect(repo.applyCreates).toHaveBeenCalled();
    // Now flagged completed, so a future re-run dedupes correctly.
    expect(findCase(await loadLedger(ledgerPath), 123)?.completed).toBe(true);
  });

  it("mints a second account under --force on a completed entry, archiving the first", async () => {
    const ledgerPath = join(dir, "ledger.json");
    await saveLedger(
      ledgerPath,
      recordCase(emptyLedger(), 123, {
        did: "did:plc:first",
        handle: "smith.rcape.org",
        password: "pw1",
        createdAt: DAY,
        completed: true,
      }),
    );
    const repo = mockRepo({ did: "did:plc:second" });
    const result = await runProvision(123, cfg(ledgerPath), {
      force: true,
      makeClient: () => clientWithCount(17),
      mapCase: async () =>
        ({
          docketRecord: {
            caseName: "Smith v. Jones",
            docketNumber: "1:23-cv-9",
          },
          entryRecords: [],
          parties: [],
          records: [],
        }) as unknown as MappedCase,
      makeAccount: (async (o: { handle: string; password: string }) => ({
        did: "did:plc:second",
        handle: o.handle,
        password: o.password,
      })) as never,
      upsertDns: (async () => ({ created: true })) as never,
      loginRepo: async () => repo,
      backfill: async () => ({ published: 0, failed: [] }),
    });
    expect(result.status).toBe("provisioned");
    const entry = findCase(await loadLedger(ledgerPath), 123);
    expect(entry?.did).toBe("did:plc:second");
    expect(entry?.completed).toBe(true);
    expect(entry?.superseded?.[0]?.did).toBe("did:plc:first");
  });

  it("returns an error instead of throwing when a post-fetch step throws", async () => {
    const ledgerPath = join(dir, "ledger.json");
    await saveLedger(ledgerPath, emptyLedger());
    const repo = mockRepo({ did: "did:plc:x" });
    const result = await runProvision(123, cfg(ledgerPath), {
      makeClient: () => clientWithCount(17),
      mapCase: async () =>
        ({
          docketRecord: {
            caseName: "Smith v. Jones",
            docketNumber: "1:23-cv-9",
          },
          entryRecords: [],
          parties: [],
          records: [],
        }) as unknown as MappedCase,
      makeAccount: (async (o: { handle: string; password: string }) => ({
        did: "did:plc:x",
        handle: o.handle,
        password: o.password,
      })) as never,
      // A PDS/DNS hiccup throws after the CL fetch — it must surface as an error
      // result, not a thrown exception that escapes drain's retry cap and loops.
      upsertDns: (async () => {
        throw new Error("Handle too long");
      }) as never,
      loginRepo: async () => repo,
      backfill: async () => ({ published: 0, failed: [] }),
    });
    expect(result.status).toBe("error");
  });
});

describe("postedHighWater", () => {
  // recapSequenceNumber sorts lexically; the entries here are pre-sorted ascending.
  const entry = (rkey: string, seq: string) => ({
    rkey,
    recapSequenceNumber: seq,
  });

  it("returns the snapshot max when nothing failed", () => {
    const entries = [entry("a", "001"), entry("b", "002"), entry("c", "003")];
    expect(postedHighWater(entries, [])).toBe("003");
  });

  it("caps below the failed rkeys so the monitor doesn't skip un-posted entries", () => {
    const entries = [entry("a", "001"), entry("b", "002"), entry("c", "003")];
    // The two highest-sequence entries failed to post → highWater must fall back
    // to the highest SUCCESSFULLY posted entry, not the snapshot max.
    expect(postedHighWater(entries, ["b", "c"])).toBe("001");
  });

  it("is undefined when every entry failed (nothing posted, nothing to advance)", () => {
    const entries = [entry("a", "001"), entry("b", "002")];
    expect(postedHighWater(entries, ["a", "b"])).toBeUndefined();
  });

  it("is undefined with no entries", () => {
    expect(postedHighWater([], [])).toBeUndefined();
  });

  it("ignores entries without a sequence number", () => {
    const entries = [
      { rkey: "a", recapSequenceNumber: undefined },
      entry("b", "002"),
    ];
    expect(postedHighWater(entries, [])).toBe("002");
  });
});

describe("announceProvisioned", () => {
  const provisioned = {
    status: "provisioned" as const,
    handle: "garciaguirre.rcape.org",
    did: "did:plc:case",
    caseName: "Garciaguirre v. Samsung Electronics Co., Ltd.",
    docketNumber: "3:26-cv-06345",
    courtName: "cand",
    published: 23,
    failed: 0,
  };

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("announces the new case via the injected bot agent (standalone post + @handle)", async () => {
    vi.stubEnv("RCAPE_ANNOUNCE_PROVISIONS", "1");
    const createRecord = vi.fn(async () => ({ uri: "at://x", cid: "c" }));
    const uploadBlob = vi.fn(async () => ({ blob: 1 }));
    await announceProvisioned(provisioned, {
      createAgent: async () => ({ createRecord, uploadBlob }),
    });
    expect(createRecord).toHaveBeenCalledTimes(1);
    const [collection, record] = createRecord.mock.calls[0] as unknown as [
      string,
      { text?: string; reply?: unknown },
    ];
    expect(collection).toBe("app.bsky.feed.post");
    expect(record.reply).toBeUndefined(); // standalone announcement, not a reply
    expect(record.text).toContain("Garciaguirre v. Samsung");
    expect(record.text).toContain("@garciaguirre.rcape.org");
  });

  it("skips entirely (never logs in) when RCAPE_ANNOUNCE_PROVISIONS is disabled", async () => {
    vi.stubEnv("RCAPE_ANNOUNCE_PROVISIONS", "false");
    const createAgent = vi.fn();
    await announceProvisioned(provisioned, { createAgent });
    expect(createAgent).not.toHaveBeenCalled();
  });

  it("swallows a bot-login failure — never throws, so it can't undo the provision", async () => {
    vi.stubEnv("RCAPE_ANNOUNCE_PROVISIONS", "1");
    await expect(
      announceProvisioned(provisioned, {
        createAgent: async () => {
          throw new Error("bot login failed");
        },
      }),
    ).resolves.toBeUndefined();
  });
});
