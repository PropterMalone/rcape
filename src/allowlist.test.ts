import { describe, expect, it, vi } from "vitest";
import {
  AllowlistCache,
  type GraphClient,
  resolveAllowlist,
} from "./allowlist.js";

// follows: paginated across 2 pages; followers: 1 page with an overlap.
function mockClient(): { client: GraphClient; calls: () => number } {
  let n = 0;
  const client: GraphClient = {
    app: {
      bsky: {
        graph: {
          getFollows: vi.fn(async ({ cursor }) => {
            n++;
            return cursor
              ? { data: { follows: [{ did: "did:c" }] } }
              : {
                  data: {
                    follows: [{ did: "did:a" }, { did: "did:b" }],
                    cursor: "p2",
                  },
                };
          }),
          getFollowers: vi.fn(async () => {
            n++;
            return {
              data: { followers: [{ did: "did:b" }, { did: "did:d" }] },
            };
          }),
        },
      },
    },
  };
  return { client, calls: () => n };
}

describe("resolveAllowlist", () => {
  it("unions the owner with paginated follows and followers, deduped", async () => {
    const { client } = mockClient();
    const set = await resolveAllowlist(client, "proptermalone.test");
    expect([...set].sort()).toEqual([
      "did:a",
      "did:b",
      "did:c",
      "did:d",
      "proptermalone.test",
    ]);
  });

  it("always includes the owner, even when absent from follows/followers", async () => {
    // The owner must be able to drive their own bot; relying on a self-follow is
    // fragile (unfollowing themselves would silently revoke access).
    const { client } = mockClient();
    const set = await resolveAllowlist(client, "did:owner");
    expect(set.has("did:owner")).toBe(true);
  });
});

describe("AllowlistCache", () => {
  it("caches within the TTL (one resolve for repeated has())", async () => {
    const { client, calls } = mockClient();
    const cache = new AllowlistCache(client, "proptermalone.test", 60_000);
    expect(await cache.has("did:a")).toBe(true);
    expect(await cache.has("did:d")).toBe(true);
    expect(await cache.has("did:zzz")).toBe(false);
    // follows(2 pages) + followers(1 page) = 3 calls, once — not re-fetched.
    expect(calls()).toBe(3);
  });

  it("re-fetches only after the TTL elapses (fake timers)", async () => {
    vi.useFakeTimers();
    try {
      const { client, calls } = mockClient();
      const cache = new AllowlistCache(client, "proptermalone.test", 60_000);
      await cache.has("did:a");
      expect(calls()).toBe(3); // first resolve

      // Within the TTL: served from cache, no re-fetch. (A `<`→`<=` off-by-one
      // regression would slip past the vacuous ttl=0 test but fail here.)
      vi.advanceTimersByTime(59_999);
      await cache.has("did:a");
      expect(calls()).toBe(3);

      // Past the TTL: re-resolves.
      vi.advanceTimersByTime(2);
      await cache.has("did:a");
      expect(calls()).toBe(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it("single-flights a concurrent refresh (two has() at expiry = one resolve)", async () => {
    // A resolveAllowlist that doesn't settle until we release it, so both has()
    // calls overlap inside ensureFresh and would each launch a fetch without the
    // single-flight guard.
    let resolveFetch: () => void = () => {};
    const gate = new Promise<void>((r) => {
      resolveFetch = r;
    });
    let resolves = 0;
    const client: GraphClient = {
      app: {
        bsky: {
          graph: {
            getFollows: vi.fn(async () => {
              resolves++;
              await gate;
              return { data: { follows: [{ did: "did:a" }] } };
            }),
            getFollowers: vi.fn(async () => ({ data: { followers: [] } })),
          },
        },
      },
    };
    const cache = new AllowlistCache(client, "owner.test", 60_000);

    // Fire both has() before the first resolve settles → they must share it.
    const p1 = cache.has("did:a");
    const p2 = cache.has("did:a");
    resolveFetch();
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toBe(true);
    expect(r2).toBe(true);
    // getFollows ran exactly once despite two concurrent has() at expiry.
    expect(resolves).toBe(1);
  });
});
