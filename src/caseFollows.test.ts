import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotAgent } from "./botAgent.js";
import {
  casesToFollow,
  completedCaseDids,
  followShelvedCasesOnce,
  followSubject,
  parseInterval,
} from "./caseFollows.js";
import {
  type CaseEntry,
  emptyLedger,
  loadLedger,
  recordCase,
  saveLedger,
} from "./ledger.js";

const caseEntry = (over: Partial<CaseEntry>): CaseEntry =>
  ({
    did: "did:plc:x",
    handle: "x.rcape.org",
    password: "pw",
    createdAt: "2026-05-30",
    completed: true,
    ...over,
  }) as CaseEntry;

describe("casesToFollow (pure diff)", () => {
  it("returns case DIDs not already followed, deduped, order-preserving", () => {
    expect(
      casesToFollow(["did:a", "did:b", "did:c", "did:b"], new Set(["did:b"])),
    ).toEqual(["did:a", "did:c"]);
  });

  it("returns empty when every case is already followed", () => {
    expect(casesToFollow(["did:a"], new Set(["did:a", "did:z"]))).toEqual([]);
  });

  it("skips empty/undefined DIDs defensively", () => {
    expect(
      casesToFollow(["did:a", "", undefined as unknown as string], new Set()),
    ).toEqual(["did:a"]);
  });
});

describe("parseInterval (malformed-env guard)", () => {
  const DEFAULT = 6 * 60 * 60 * 1000;
  it("honors a finite positive override", () => {
    expect(parseInterval("1800000")).toBe(1_800_000);
  });
  it("falls back to the default on NaN (a typo — would wedge: never due)", () => {
    expect(parseInterval("abc")).toBe(DEFAULT);
  });
  it("falls back to the default on empty string (would spin: 0 → due every poll)", () => {
    expect(parseInterval("")).toBe(DEFAULT);
  });
  it("falls back on zero/negative and undefined", () => {
    expect(parseInterval("0")).toBe(DEFAULT);
    expect(parseInterval("-5")).toBe(DEFAULT);
    expect(parseInterval(undefined)).toBe(DEFAULT);
  });
});

describe("followSubject", () => {
  it("reads the subject DID from a follow record value", () => {
    expect(
      followSubject({ $type: "app.bsky.graph.follow", subject: "did:a" }),
    ).toBe("did:a");
  });
  it("returns undefined for a malformed record", () => {
    expect(followSubject(null)).toBeUndefined();
    expect(followSubject({ subject: 123 })).toBeUndefined();
    expect(followSubject("nope")).toBeUndefined();
  });
});

describe("completedCaseDids", () => {
  it("includes only completed cases with a did AND handle", () => {
    let l = emptyLedger();
    l = recordCase(l, 1, caseEntry({ did: "did:1", handle: "a.rcape.org" }));
    l = recordCase(l, 2, caseEntry({ did: "did:2", completed: false })); // not completed
    l = recordCase(
      l,
      3,
      caseEntry({ did: undefined as unknown as string, handle: "c.rcape.org" }),
    ); // no did (crash zombie)
    expect(completedCaseDids(l).sort()).toEqual(["did:1"]);
  });
});

function mockAgent(existingFollowSubjects: string[]): {
  agent: Pick<BotAgent, "listRecords" | "createRecord">;
  created: { collection: string; record: unknown }[];
} {
  const created: { collection: string; record: unknown }[] = [];
  const agent = {
    listRecords: async (collection: string) => {
      if (collection !== "app.bsky.graph.follow") return [];
      return existingFollowSubjects.map((did, i) => ({
        uri: `at://did:bot/app.bsky.graph.follow/${i}`,
        value: { $type: "app.bsky.graph.follow", subject: did },
      }));
    },
    createRecord: async (collection: string, record: unknown) => {
      created.push({ collection, record });
      return { uri: `at://did:bot/${collection}/new`, cid: "c" };
    },
  };
  return { agent, created };
}

describe("followShelvedCasesOnce (shell)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "rcape-follows-"));
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-14T12:00:00Z"));
  });
  afterEach(async () => {
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  });

  const seedLedger = async (dids: string[]) => {
    let l = emptyLedger();
    dids.forEach((did, i) => {
      l = recordCase(l, i + 1, caseEntry({ did, handle: `c${i}.rcape.org` }));
    });
    const ledgerPath = join(dir, "ledger.json");
    await saveLedger(ledgerPath, l);
    return ledgerPath;
  };

  it("backfills all shelved cases on first run (no sweptAt), then stamps", async () => {
    const ledgerPath = await seedLedger(["did:1", "did:2", "did:3"]);
    const { agent, created } = mockAgent([]);

    const res = await followShelvedCasesOnce({ agent, cfg: { ledgerPath } });

    expect(res.followed).toBe(3);
    expect(created).toHaveLength(3);
    expect(created.every((c) => c.collection === "app.bsky.graph.follow")).toBe(
      true,
    );
    expect(
      created.map((c) => (c.record as { subject: string }).subject).sort(),
    ).toEqual(["did:1", "did:2", "did:3"]);
    // Assert the full follow-record SHAPE, not just the subject: a lexicon
    // regression (wrong $type, missing createdAt) would otherwise 400 at the PDS,
    // be swallowed by the best-effort catch, and silently kill the feature with
    // the suite still green.
    const rec = created[0]?.record as {
      $type: string;
      subject: string;
      createdAt: string;
    };
    expect(rec.$type).toBe("app.bsky.graph.follow");
    expect(typeof rec.subject).toBe("string");
    expect(() => new Date(rec.createdAt).toISOString()).not.toThrow();
    expect(rec.createdAt).toBe("2026-07-14T12:00:00.000Z");
    // Cadence marker stamped so the next cycle doesn't re-list until due.
    const after = await loadLedger(ledgerPath);
    expect(after.follows?.sweptAt).toBe("2026-07-14T12:00:00.000Z");
  });

  it("follows only the cases not already followed", async () => {
    const ledgerPath = await seedLedger(["did:1", "did:2", "did:3"]);
    const { agent, created } = mockAgent(["did:1", "did:3"]);

    const res = await followShelvedCasesOnce({ agent, cfg: { ledgerPath } });

    expect(res.followed).toBe(1);
    expect((created[0]?.record as { subject: string }).subject).toBe("did:2");
  });

  it("is a no-op (no re-list, no writes) when not due and not forced", async () => {
    const ledgerPath = await seedLedger(["did:1"]);
    // Stamp sweptAt to just now → not due under the default interval.
    let l = await loadLedger(ledgerPath);
    l = { ...l, follows: { sweptAt: "2026-07-14T11:59:00.000Z" } };
    await saveLedger(ledgerPath, l);
    const listSpy = vi.fn(async () => []);
    const { created } = mockAgent([]);
    const agent = {
      listRecords: listSpy,
      createRecord: async (collection: string, record: unknown) => {
        created.push({ collection, record });
        return { uri: "at://x", cid: "c" };
      },
    };

    const res = await followShelvedCasesOnce({ agent, cfg: { ledgerPath } });

    expect(res.followed).toBe(0);
    expect(listSpy).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
  });

  it("runs despite a recent sweptAt when forced (a shelf change this cycle)", async () => {
    const ledgerPath = await seedLedger(["did:1"]);
    let l = await loadLedger(ledgerPath);
    l = { ...l, follows: { sweptAt: "2026-07-14T11:59:00.000Z" } };
    await saveLedger(ledgerPath, l);
    const { agent, created } = mockAgent([]);

    const res = await followShelvedCasesOnce(
      { agent, cfg: { ledgerPath } },
      { force: true },
    );

    expect(res.followed).toBe(1);
    expect(created).toHaveLength(1);
  });

  it("keeps going when one follow write fails (best-effort per case)", async () => {
    const ledgerPath = await seedLedger(["did:1", "did:2", "did:3"]);
    const created: { collection: string; record: unknown }[] = [];
    const agent = {
      listRecords: async () => [],
      createRecord: async (collection: string, record: unknown) => {
        const subject = (record as { subject: string }).subject;
        if (subject === "did:2") throw new Error("PDS 502");
        created.push({ collection, record });
        return { uri: "at://x", cid: "c" };
      },
    };

    const res = await followShelvedCasesOnce({ agent, cfg: { ledgerPath } });

    // did:1 and did:3 followed; did:2 failed but didn't abort the sweep.
    expect(res.followed).toBe(2);
    expect(
      created.map((c) => (c.record as { subject: string }).subject).sort(),
    ).toEqual(["did:1", "did:3"]);
    // Still stamped so the next cycle waits; did:2 retried on the next due sweep
    // (it's still unfollowed, so it reappears in the diff).
    const after = await loadLedger(ledgerPath);
    expect(after.follows?.sweptAt).toBe("2026-07-14T12:00:00.000Z");
  });
});
