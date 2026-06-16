import { describe, expect, it, vi } from "vitest";
import { CourtListenerClient, parseClTokens } from "./courtlistener.js";

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
