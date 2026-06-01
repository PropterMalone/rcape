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
