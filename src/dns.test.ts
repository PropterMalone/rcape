import { describe, expect, it, vi } from "vitest";
import { upsertAtprotoTxt, upsertLexiconTxt } from "./dns.js";

type Json = { success: boolean; result?: unknown; errors?: unknown };

function res(status: number, body: Json): Response {
  return {
    ok: status < 400,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("upsertAtprotoTxt", () => {
  it("creates a new _atproto TXT when none exists", async () => {
    const calls: { url: string; method?: string; body?: unknown }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: init?.method,
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      if (init?.method === "POST") {
        return res(200, { success: true, result: { id: "rec1" } });
      }
      return res(200, { success: true, result: [] }); // GET: none found
    });

    const out = await upsertAtprotoTxt("smith.rcape.org", "did:plc:abc", {
      zoneId: "zone1",
      token: "tok",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(out).toEqual({ created: true });
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toEqual({
      type: "TXT",
      name: "_atproto.smith.rcape.org",
      content: "did=did:plc:abc",
      ttl: 60,
    });
    // The lookup must use the documented dot-notation exact filter, not the
    // silently-ignored `name[exact]` bracket form (which returns every TXT
    // record and risks overwriting an unrelated one). encodeURIComponent leaves
    // dots/underscores literal, so the name appears verbatim.
    const get = calls.find((c) => c.method === "GET");
    expect(get?.url).toContain("name.exact=_atproto.smith.rcape.org");
    expect(get?.url).not.toContain("name[exact]");
  });

  it("updates the existing record (PUT) when one is present", async () => {
    const calls: { url: string; method?: string; body?: unknown }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: init?.method,
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      if (init?.method === "PUT")
        return res(200, { success: true, result: {} });
      return res(200, { success: true, result: [{ id: "rec9" }] });
    });

    const out = await upsertAtprotoTxt("a.rcape.org", "did:plc:xyz", {
      zoneId: "z",
      token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(out).toEqual({ created: false });
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.url.endsWith("/rec9")).toBe(true);
    // The update must carry the correct DID — a wrong-DID regression must fail.
    expect(put?.body).toEqual({
      type: "TXT",
      name: "_atproto.a.rcape.org",
      content: "did=did:plc:xyz",
      ttl: 60,
    });
  });

  it("throws on a Cloudflare error response", async () => {
    const fetchImpl = vi.fn(async () =>
      res(200, { success: false, errors: [{ message: "bad zone" }] }),
    );
    await expect(
      upsertAtprotoTxt("a.rcape.org", "did:plc:x", {
        zoneId: "z",
        token: "t",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/Cloudflare/);
  });
});

describe("upsertLexiconTxt", () => {
  it("creates the _lexicon.<authority> TXT pointing at the publisher DID", async () => {
    const calls: { url: string; method?: string; body?: unknown }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: init?.method,
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      if (init?.method === "POST")
        return res(200, { success: true, result: { id: "lex1" } });
      return res(200, { success: true, result: [] });
    });

    const out = await upsertLexiconTxt("rcape.org", "did:plc:bot", {
      zoneId: "z",
      token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(out).toEqual({ created: true });
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toEqual({
      type: "TXT",
      name: "_lexicon.rcape.org",
      content: "did=did:plc:bot",
      ttl: 60,
    });
    const get = calls.find((c) => c.method === "GET");
    expect(get?.url).toContain("name.exact=_lexicon.rcape.org");
  });
});
