import { describe, expect, it, vi } from "vitest";
import { AllowlistCache, type GraphClient } from "./allowlist.js";

// A getRelationships mock: the owner follows did:a; did:b follows the owner;
// did:zzz has neither edge. Counts calls so caching/single-flight can be checked.
function mockClient(): { client: GraphClient; calls: () => number } {
  let n = 0;
  const rels: Record<string, { following?: string; followedBy?: string }> = {
    "did:a": { following: "at://owner/app.bsky.graph.follow/1" },
    "did:b": { followedBy: "at://them/app.bsky.graph.follow/1" },
    "did:zzz": {},
  };
  const client: GraphClient = {
    app: {
      bsky: {
        graph: {
          getRelationships: vi.fn(async ({ others }) => {
            n++;
            return {
              data: {
                relationships: others.map((did: string) => ({
                  did,
                  ...(rels[did] ?? {}),
                })),
              },
            };
          }),
        },
      },
    },
  };
  return { client, calls: () => n };
}

describe("AllowlistCache", () => {
  it("admits an account the owner follows OR that follows the owner; rejects neither", async () => {
    const { client } = mockClient();
    const c = new AllowlistCache(client, "did:owner", 60_000);
    expect(await c.has("did:a")).toBe(true); // owner follows them
    expect(await c.has("did:b")).toBe(true); // they follow owner (the jack case)
    expect(await c.has("did:zzz")).toBe(false); // neither edge
  });

  it("always admits the owner without a graph call", async () => {
    const { client, calls } = mockClient();
    const c = new AllowlistCache(client, "did:owner", 60_000);
    expect(await c.has("did:owner")).toBe(true);
    expect(calls()).toBe(0);
  });

  it("caches per-DID within the TTL (one getRelationships per repeated has)", async () => {
    const { client, calls } = mockClient();
    const c = new AllowlistCache(client, "did:owner", 60_000);
    await c.has("did:a");
    await c.has("did:a");
    await c.has("did:a");
    expect(calls()).toBe(1);
  });

  it("looks up distinct DIDs independently", async () => {
    const { client, calls } = mockClient();
    const c = new AllowlistCache(client, "did:owner", 60_000);
    await c.has("did:a");
    await c.has("did:b");
    expect(calls()).toBe(2);
  });

  it("re-fetches only after the TTL elapses (fake timers)", async () => {
    vi.useFakeTimers();
    try {
      const { client, calls } = mockClient();
      const c = new AllowlistCache(client, "did:owner", 60_000);
      await c.has("did:a");
      expect(calls()).toBe(1);

      // Within the TTL: served from cache. (A `<`→`<=` off-by-one would slip past
      // a vacuous ttl=0 test but fail here.)
      vi.advanceTimersByTime(59_999);
      await c.has("did:a");
      expect(calls()).toBe(1);

      // Past the TTL: re-resolves.
      vi.advanceTimersByTime(2);
      await c.has("did:a");
      expect(calls()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("single-flights concurrent has(did) at expiry (one getRelationships)", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let n = 0;
    const client: GraphClient = {
      app: {
        bsky: {
          graph: {
            getRelationships: vi.fn(async ({ others }) => {
              n++;
              await gate;
              return {
                data: {
                  relationships: others.map((did: string) => ({
                    did,
                    followedBy: "at://x",
                  })),
                },
              };
            }),
          },
        },
      },
    };
    const c = new AllowlistCache(client, "did:owner", 60_000);

    const p1 = c.has("did:a");
    const p2 = c.has("did:a");
    release();
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toBe(true);
    expect(r2).toBe(true);
    expect(n).toBe(1); // one lookup despite two concurrent has() at expiry
  });
});
