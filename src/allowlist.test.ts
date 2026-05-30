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
  it("unions paginated follows with followers, deduped", async () => {
    const { client } = mockClient();
    const set = await resolveAllowlist(client, "proptermalone.test");
    expect([...set].sort()).toEqual(["did:a", "did:b", "did:c", "did:d"]);
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

  it("refreshes after the TTL expires", async () => {
    const { client, calls } = mockClient();
    const cache = new AllowlistCache(client, "proptermalone.test", 0);
    await cache.has("did:a");
    await cache.has("did:a");
    expect(calls()).toBe(6); // re-resolved on the second call (ttl 0)
  });
});
