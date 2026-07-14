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
