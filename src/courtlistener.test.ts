import { describe, expect, it, vi } from "vitest";
import {
  CourtListenerClient,
  ThrottledError,
  parseClTokens,
} from "./courtlistener.js";

function res(status: number, body: unknown): Response {
  return {
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("CourtListenerClient pagination SSRF guard", () => {
  it("refuses to follow a 'next' link that points off courtlistener.com", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      seen.push(url);
      // A crafted next pointing at an attacker host that would receive the token.
      return res(200, {
        results: [{}],
        next: "https://evil.example.com/api/rest/v4/steal",
      });
    });
    // minIntervalMs 0 disables the self-throttle sleep for the test.
    const client = new CourtListenerClient(
      "secret-token",
      fetchImpl as unknown as typeof fetch,
      0,
    );
    await expect(client.getAllDocketEntries(123)).rejects.toThrow(
      /off-host|courtlistener/i,
    );
    // The token-bearing request never reached the attacker host.
    expect(seen.some((u) => u.includes("evil.example.com"))).toBe(false);
  });

  it("follows a same-origin 'next' link normally", async () => {
    let page = 0;
    const fetchImpl = vi.fn(async () => {
      page += 1;
      if (page === 1) {
        return res(200, {
          results: [{ a: 1 }],
          next: "https://www.courtlistener.com/api/rest/v4/docket-entries/?docket=123&page=2",
        });
      }
      return res(200, { results: [{ a: 2 }], next: null });
    });
    const client = new CourtListenerClient(
      "t",
      fetchImpl as unknown as typeof fetch,
      0,
    );
    const out = await client.getAllDocketEntries(123);
    expect(out).toHaveLength(2);
  });
});

describe("resumable pagination", () => {
  const CL = "https://www.courtlistener.com/api/rest/v4";

  it("resumeFrom starts at the saved cursor, not page 1", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      seen.push(url);
      return res(200, { results: [{ a: 1 }], next: null });
    });
    const client = new CourtListenerClient(
      "t",
      fetchImpl as unknown as typeof fetch,
      0,
    );
    const cursor = `${CL}/docket-entries/?docket=123&cursor=PAGE3`;
    const { results, next } = await client.fetchDocketEntries(123, {
      resumeFrom: cursor,
    });
    expect(seen[0]).toBe(cursor); // jumped straight to the cursor
    expect(seen.some((u) => u.includes("page_size=100"))).toBe(false);
    expect(results).toHaveLength(1);
    expect(next).toBeNull();
  });

  it("onPage fires per page in order with the post-page cursor; final next is null", async () => {
    let page = 0;
    const fetchImpl = vi.fn(async () => {
      page += 1;
      return page === 1
        ? res(200, {
            results: [{ a: 1 }],
            next: `${CL}/docket-entries/?cursor=p2`,
          })
        : res(200, { results: [{ a: 2 }], next: null });
    });
    const client = new CourtListenerClient(
      "t",
      fetchImpl as unknown as typeof fetch,
      0,
    );
    const calls: Array<{ n: number; next: string | null }> = [];
    const { results, next } = await client.fetchDocketEntries(123, {
      onPage: async (r, nx) => {
        calls.push({ n: r.length, next: nx });
      },
    });
    expect(calls).toEqual([
      { n: 1, next: `${CL}/docket-entries/?cursor=p2` },
      { n: 1, next: null },
    ]);
    expect(results).toHaveLength(2);
    expect(next).toBeNull();
  });

  it("returns a non-null next when MAX_PAGES (50) is hit — the per-window cap", async () => {
    // Every page advertises another, so the loop stops at MAX_PAGES with work left.
    const fetchImpl = vi.fn(async () =>
      res(200, {
        results: [{ a: 1 }],
        next: `${CL}/docket-entries/?cursor=more`,
      }),
    );
    const client = new CourtListenerClient(
      "t",
      fetchImpl as unknown as typeof fetch,
      0,
    );
    const { results, next } = await client.fetchDocketEntries(123);
    expect(results).toHaveLength(50); // MAX_PAGES
    expect(next).toBe(`${CL}/docket-entries/?cursor=more`); // resume next window
    expect(client.requestCount).toBe(50); // counts only this call's pages
  });
});

describe("429 handling", () => {
  it("throws ThrottledError without sleeping when the cooldown exceeds the cap", async () => {
    // The hourly/daily window: an 800s cooldown would freeze the drain loop. It
    // must surface as a typed error instead, fast, with the request made once.
    const fetchImpl = vi.fn(async () =>
      res(429, {
        detail:
          "Request was throttled. Rate limit exceeded: 50/hour. Expected available in 800 seconds.",
      }),
    );
    const client = new CourtListenerClient(
      "t",
      fetchImpl as unknown as typeof fetch,
      0,
    );
    const err = await client.getDocket(1).catch((e) => e);
    expect(err).toBeInstanceOf(ThrottledError);
    expect((err as ThrottledError).retryAfterMs).toBe(802_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sleeps through and retries a short (sub-cap) 429, then succeeds", async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      const fetchImpl = vi.fn(async () => {
        n += 1;
        return n === 1
          ? res(429, { detail: "throttled. Expected available in 5 seconds." })
          : res(200, { id: 1 });
      });
      const client = new CourtListenerClient(
        "t",
        fetchImpl as unknown as typeof fetch,
        0,
      );
      const p = client.getDocket(1);
      await vi.advanceTimersByTimeAsync(7_000); // (5 + 2)s cooldown
      await expect(p).resolves.toEqual({ id: 1 });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("searchDockets", () => {
  it("queries type=d with a quoted caseName operator and the court filter", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      seen.push(url);
      return res(200, {
        count: 1,
        results: [{ docket_id: 69777799, caseName: "Abrego Garcia v. Noem" }],
      });
    });
    const client = new CourtListenerClient(
      "t",
      fetchImpl as unknown as typeof fetch,
      0,
    );
    const out = await client.searchDockets("Abrego Garcia v. Noem", "mdd");
    expect(out.count).toBe(1);
    expect(out.results[0]?.docket_id).toBe(69777799);
    expect(seen).toHaveLength(1);
    const url = new URL(seen[0] as string);
    expect(url.pathname).toBe("/api/rest/v4/search/");
    expect(url.searchParams.get("type")).toBe("d");
    expect(url.searchParams.get("q")).toBe('caseName:"Abrego Garcia v. Noem"');
    expect(url.searchParams.get("court")).toBe("mdd");
  });

  it("omits the court filter when no court id is given", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      seen.push(url);
      return res(200, { count: 0, results: [] });
    });
    const client = new CourtListenerClient(
      "t",
      fetchImpl as unknown as typeof fetch,
      0,
    );
    await client.searchDockets("United States v. Smith");
    expect(new URL(seen[0] as string).searchParams.has("court")).toBe(false);
  });

  it("never paginates — one search is one quota call, count rides on page 1", async () => {
    const fetchImpl = vi.fn(async () =>
      res(200, {
        count: 40,
        next: "https://www.courtlistener.com/api/rest/v4/search/?cursor=abc",
        results: [{ docket_id: 1 }, { docket_id: 2 }],
      }),
    );
    const client = new CourtListenerClient(
      "t",
      fetchImpl as unknown as typeof fetch,
      0,
    );
    const out = await client.searchDockets("Smith v. Jones");
    expect(out.count).toBe(40);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("falls back to results.length when count is not a number", async () => {
    const fetchImpl = vi.fn(async () =>
      res(200, { count: null, results: [{ docket_id: 5 }] }),
    );
    const client = new CourtListenerClient(
      "t",
      fetchImpl as unknown as typeof fetch,
      0,
    );
    const out = await client.searchDockets("Doe v. Roe");
    expect(out.count).toBe(1);
  });
});

describe("searchByDocketNumber", () => {
  it("queries type=d with a quoted docketNumber operator", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      seen.push(url);
      return res(200, {
        count: 1,
        results: [{ docket_id: 73482575, caseName: "Kahn v. Anthropic PBC" }],
      });
    });
    const client = new CourtListenerClient(
      "t",
      fetchImpl as unknown as typeof fetch,
      0,
    );
    const out = await client.searchByDocketNumber("3:26-cv-05763");
    expect(out.count).toBe(1);
    expect(out.results[0]?.docket_id).toBe(73482575);
    const url = new URL(seen[0] as string);
    expect(url.pathname).toBe("/api/rest/v4/search/");
    expect(url.searchParams.get("type")).toBe("d");
    expect(url.searchParams.get("q")).toBe('docketNumber:"3:26-cv-05763"');
  });

  it("reports the full count for a multi-docket case number (gate then suggests)", async () => {
    const fetchImpl = vi.fn(async () =>
      res(200, { count: 16, results: [{ docket_id: 1 }, { docket_id: 2 }] }),
    );
    const client = new CourtListenerClient(
      "t",
      fetchImpl as unknown as typeof fetch,
      0,
    );
    const out = await client.searchByDocketNumber("0:26-cr-00115");
    expect(out.count).toBe(16);
  });
});

describe("parseClTokens", () => {
  it("parses a comma-separated pool, trimming and de-duping", () => {
    expect(
      parseClTokens({
        COURTLISTENER_API_TOKENS: " a , b ,a, c ",
      } as NodeJS.ProcessEnv),
    ).toEqual(["a", "b", "c"]);
  });

  it("falls back to the single legacy token when the pool var is unset", () => {
    expect(
      parseClTokens({ COURTLISTENER_API_TOKEN: "solo" } as NodeJS.ProcessEnv),
    ).toEqual(["solo"]);
  });

  it("prefers the pool var over the single token when both are set", () => {
    expect(
      parseClTokens({
        COURTLISTENER_API_TOKENS: "a,b",
        COURTLISTENER_API_TOKEN: "solo",
      } as NodeJS.ProcessEnv),
    ).toEqual(["a", "b"]);
  });

  it("throws when neither var is set", () => {
    expect(() => parseClTokens({} as NodeJS.ProcessEnv)).toThrow(
      /COURTLISTENER_API_TOKEN/,
    );
  });
});
