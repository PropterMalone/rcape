import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CaseEntry,
  type Ledger,
  chargeQuota,
  emptyLedger,
  loadLedger,
  saveLedger,
} from "./ledger.js";
import type { ProvisionConfig, ProvisionResult } from "./provisionCase.js";
import {
  type ListFeedResult,
  type RawListFeedItem,
  type WatchPost,
  type WatchlistDeps,
  attributedDidOf,
  mapListFeedItem,
  tallyDocketAttention,
  watchlistSweepOnce,
} from "./watchlist.js";

const DOCKET_URL = (id: number) =>
  `https://www.courtlistener.com/docket/${id}/some-case/`;

const post = (over: Partial<WatchPost> = {}): WatchPost => ({
  attributedDid: "did:plc:a",
  links: [],
  ...over,
});

describe("attributedDidOf", () => {
  it("credits the original author for an ordinary post", () => {
    expect(attributedDidOf("did:plc:author")).toBe("did:plc:author");
  });
  it("credits the reposter for a repost (the boost is the signal)", () => {
    expect(
      attributedDidOf("did:plc:author", {
        $type: "app.bsky.feed.defs#reasonRepost",
        by: { did: "did:plc:booster" },
      }),
    ).toBe("did:plc:booster");
  });
  it("falls back to author when a non-repost reason has no by.did", () => {
    expect(attributedDidOf("did:plc:author", { $type: "something#else" })).toBe(
      "did:plc:author",
    );
  });
});

describe("mapListFeedItem", () => {
  const item = (over: Partial<RawListFeedItem> = {}): RawListFeedItem => ({
    post: {
      author: { did: "did:plc:author" },
      record: {
        text: "see the docket",
        // Real posts carry the URL in a #link facet (Bluesky truncates it in the
        // visible text); extractPostLinks reads facets/embed, not plain text.
        facets: [
          {
            features: [
              {
                $type: "app.bsky.richtext.facet#link",
                uri: DOCKET_URL(55),
              },
            ],
          },
        ],
      },
      uri: "at://did:plc:author/app.bsky.feed.post/abc",
      indexedAt: "2026-06-20T00:00:00.000Z",
    },
    ...over,
  });

  it("maps a plain post: author attribution + extracted links + text", () => {
    const got = mapListFeedItem(item());
    expect(got).not.toBeNull();
    expect(got?.attributedDid).toBe("did:plc:author");
    expect(got?.links).toContain(DOCKET_URL(55));
    expect(got?.text).toBe("see the docket");
    expect(got?.uri).toBe("at://did:plc:author/app.bsky.feed.post/abc");
  });

  it("credits the reposter for a repost", () => {
    const got = mapListFeedItem(
      item({
        reason: {
          $type: "app.bsky.feed.defs#reasonRepost",
          by: { did: "did:plc:booster" },
        },
      }),
    );
    expect(got?.attributedDid).toBe("did:plc:booster");
  });

  it("returns null for a postless item (deleted/blocked/hydration failure)", () => {
    expect(mapListFeedItem({})).toBeNull();
    expect(mapListFeedItem({ post: {} })).toBeNull();
    expect(mapListFeedItem({ post: { author: {} } })).toBeNull();
  });

  it("tolerates a missing record (no links, no throw)", () => {
    const got = mapListFeedItem({ post: { author: { did: "did:x" } } });
    expect(got).toEqual({
      attributedDid: "did:x",
      links: [],
      text: undefined,
      uri: undefined,
      indexedAt: undefined,
    });
  });
});

describe("tallyDocketAttention", () => {
  it("trips a docket linked by one member at threshold 1", () => {
    const got = tallyDocketAttention([post({ links: [DOCKET_URL(500)] })], 1);
    expect(got).toEqual([{ docketId: 500, accounts: ["did:plc:a"] }]);
  });

  it("does not trip below threshold; trips with distinct accounts at threshold 2", () => {
    const one = tallyDocketAttention(
      [post({ attributedDid: "did:a", links: [DOCKET_URL(7)] })],
      2,
    );
    expect(one).toEqual([]);

    const two = tallyDocketAttention(
      [
        post({ attributedDid: "did:a", links: [DOCKET_URL(7)] }),
        post({ attributedDid: "did:b", links: [DOCKET_URL(7)] }),
      ],
      2,
    );
    expect(two).toHaveLength(1);
    expect(two[0]?.docketId).toBe(7);
    expect(new Set(two[0]?.accounts)).toEqual(new Set(["did:a", "did:b"]));
  });

  it("counts one member sharing the same docket twice as one", () => {
    const got = tallyDocketAttention(
      [
        post({ attributedDid: "did:a", links: [DOCKET_URL(9)] }),
        post({ attributedDid: "did:a", links: [DOCKET_URL(9)] }),
      ],
      2,
    );
    expect(got).toEqual([]); // still just one distinct account
  });

  it("reads a docket link from the post text when no link facet carries it", () => {
    const got = tallyDocketAttention(
      [post({ text: `look at ${DOCKET_URL(42)}` })],
      1,
    );
    expect(got).toEqual([{ docketId: 42, accounts: ["did:plc:a"] }]);
  });

  it("ignores posts with no docket link", () => {
    expect(
      tallyDocketAttention([post({ text: "no link here", links: [] })], 1),
    ).toEqual([]);
  });

  it("sorts most-attention first so the cap shelves the hottest cases", () => {
    const got = tallyDocketAttention(
      [
        post({ attributedDid: "did:a", links: [DOCKET_URL(1)] }),
        post({ attributedDid: "did:a", links: [DOCKET_URL(2)] }),
        post({ attributedDid: "did:b", links: [DOCKET_URL(2)] }),
      ],
      1,
    );
    expect(got.map((d) => d.docketId)).toEqual([2, 1]); // docket 2 has 2 accounts
  });
});

// ---- shell ----

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rcape-watchlist-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const NOW = Date.parse("2026-06-20T12:00:00.000Z");
const OLD = "2026-01-01T00:00:00.000Z"; // older than any cadence

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
  ...over,
});

const okResult: ProvisionResult = {
  status: "provisioned",
  handle: "case.rcape.org",
  did: "did:new",
  caseName: "X v. Y",
  published: 3,
  failed: 0,
};

function feedAgent(items: WatchPost[]): {
  getListFeed: ReturnType<typeof vi.fn>;
} {
  return {
    getListFeed: vi.fn(async (): Promise<ListFeedResult> => ({ items })),
  };
}

async function writeLedger(
  path: string,
  mutate: (l: Ledger) => Ledger = (l) => l,
): Promise<void> {
  await saveLedger(path, mutate(emptyLedger()));
}

function deps(
  ledgerPath: string,
  agent: { getListFeed: ReturnType<typeof vi.fn> },
  provision: ReturnType<typeof vi.fn>,
  over: Partial<WatchlistDeps["watchlist"]> = {},
): WatchlistDeps {
  return {
    agent,
    cfg: cfg(ledgerPath),
    provision,
    watchlist: {
      listUri: "at://did:plc:owner/app.bsky.graph.list/watch",
      threshold: 1,
      intervalMs: 60_000,
      maxPerCycle: 3,
      ...over,
    },
  };
}

describe("watchlistSweepOnce", () => {
  it("is a no-op when no watchlist is configured", async () => {
    const path = join(dir, "ledger.json");
    await writeLedger(path);
    const agent = feedAgent([]);
    const provision = vi.fn();
    const d = { agent, cfg: cfg(path), provision }; // no .watchlist
    const got = await watchlistSweepOnce(d as WatchlistDeps, {
      now: () => NOW,
    });
    expect(got).toEqual({ provisioned: 0, tripped: 0 });
    expect(agent.getListFeed).not.toHaveBeenCalled();
  });

  it("skips the feed read when within the cadence interval", async () => {
    const path = join(dir, "ledger.json");
    const recent = new Date(NOW - 1_000).toISOString();
    await writeLedger(path, (l) => ({ ...l, watchlist: { sweptAt: recent } }));
    const agent = feedAgent([post({ links: [DOCKET_URL(1)] })]);
    const provision = vi.fn(async () => okResult);
    const got = await watchlistSweepOnce(deps(path, agent, provision), {
      now: () => NOW,
    });
    expect(got.provisioned).toBe(0);
    expect(agent.getListFeed).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
  });

  it("auto-shelves a tripped docket when budget allows and stamps sweptAt", async () => {
    const path = join(dir, "ledger.json");
    await writeLedger(path);
    const agent = feedAgent([post({ links: [DOCKET_URL(1234)] })]);
    const provision = vi.fn(async () => okResult);
    const got = await watchlistSweepOnce(deps(path, agent, provision), {
      now: () => NOW,
    });
    expect(got).toEqual({ provisioned: 1, tripped: 1 });
    expect(provision).toHaveBeenCalledWith(1234, expect.anything());
    const after = await loadLedger(path);
    expect(after.watchlist?.sweptAt).toBe(new Date(NOW).toISOString());
  });

  it("skips a docket the bot already knows (no re-provision)", async () => {
    const path = join(dir, "ledger.json");
    await writeLedger(path, (l) => ({
      ...l,
      cases: { "1234": completedCase() },
    }));
    const agent = feedAgent([post({ links: [DOCKET_URL(1234)] })]);
    const provision = vi.fn(async () => okResult);
    const got = await watchlistSweepOnce(deps(path, agent, provision), {
      now: () => NOW,
    });
    expect(got.provisioned).toBe(0);
    expect(provision).not.toHaveBeenCalled();
  });

  it("does not provision when budget is below the floor", async () => {
    const path = join(dir, "ledger.json");
    const day = new Date(NOW).toISOString().slice(0, 10);
    // Leave 10 calls; set the floor explicitly above it (config override, not the
    // module constant) so the test states its own threshold rather than depending
    // on the env-derived default.
    await writeLedger(path, (l) => chargeQuota(l, 125 - 10, day, "t"));
    const agent = feedAgent([post({ links: [DOCKET_URL(1234)] })]);
    const provision = vi.fn(async () => okResult);
    const got = await watchlistSweepOnce(
      deps(path, agent, provision, { provisionFloor: 15 }),
      { now: () => NOW },
    );
    expect(got.provisioned).toBe(0);
    expect(provision).not.toHaveBeenCalled();
  });

  it("provisions when budget clears the floor", async () => {
    const path = join(dir, "ledger.json");
    const day = new Date(NOW).toISOString().slice(0, 10);
    // Leave 20 calls; floor 15 → clears, so it provisions.
    await writeLedger(path, (l) => chargeQuota(l, 125 - 20, day, "t"));
    const agent = feedAgent([post({ links: [DOCKET_URL(1234)] })]);
    const provision = vi.fn(async () => okResult);
    const got = await watchlistSweepOnce(
      deps(path, agent, provision, { provisionFloor: 15 }),
      { now: () => NOW },
    );
    expect(got.provisioned).toBe(1);
  });

  it("treats threshold 0 as 1 (defensive clamp, no flood)", async () => {
    const path = join(dir, "ledger.json");
    await writeLedger(path);
    const agent = feedAgent([
      post({ attributedDid: "did:a", links: [DOCKET_URL(1)] }),
    ]);
    const provision = vi.fn(async () => okResult);
    const got = await watchlistSweepOnce(
      deps(path, agent, provision, { threshold: 0, maxPerCycle: 5 }),
      { now: () => NOW },
    );
    expect(got.tripped).toBe(1); // same as threshold 1 — clamp holds the floor
    expect(provision).toHaveBeenCalledTimes(1);
  });

  it("honors the per-cycle cap, shelving the hottest first", async () => {
    const path = join(dir, "ledger.json");
    await writeLedger(path);
    const agent = feedAgent([
      // docket 2 → 2 accounts (hottest), dockets 1 and 3 → 1 each
      post({ attributedDid: "did:a", links: [DOCKET_URL(1)] }),
      post({ attributedDid: "did:a", links: [DOCKET_URL(2)] }),
      post({ attributedDid: "did:b", links: [DOCKET_URL(2)] }),
      post({ attributedDid: "did:c", links: [DOCKET_URL(3)] }),
    ]);
    const provision = vi.fn(async () => okResult);
    const got = await watchlistSweepOnce(
      deps(path, agent, provision, { maxPerCycle: 1 }),
      { now: () => NOW },
    );
    expect(got).toEqual({ provisioned: 1, tripped: 3 });
    expect(provision).toHaveBeenCalledTimes(1);
    expect(provision).toHaveBeenCalledWith(2, expect.anything());
  });

  it("stops the cycle when a provision reports quota-exhausted", async () => {
    const path = join(dir, "ledger.json");
    await writeLedger(path);
    const agent = feedAgent([
      post({ attributedDid: "did:a", links: [DOCKET_URL(1)] }),
      post({ attributedDid: "did:b", links: [DOCKET_URL(2)] }),
    ]);
    const provision = vi.fn(async () => ({
      status: "quota-exhausted" as const,
      day: "2026-06-20",
    }));
    const got = await watchlistSweepOnce(deps(path, agent, provision), {
      now: () => NOW,
    });
    expect(got.provisioned).toBe(0);
    expect(provision).toHaveBeenCalledTimes(1); // stopped after the first
  });
});
