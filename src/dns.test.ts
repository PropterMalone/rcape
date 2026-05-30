import { describe, expect, it, vi } from "vitest";
import { upsertAtprotoTxt } from "./dns.js";

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
  });

  it("updates the existing record (PUT) when one is present", async () => {
    const calls: { url: string; method?: string }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method });
      if (init?.method === "PUT") return res(200, { success: true, result: {} });
      return res(200, { success: true, result: [{ id: "rec9" }] });
    });

    const out = await upsertAtprotoTxt("a.rcape.org", "did:plc:xyz", {
      zoneId: "z",
      token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(out).toEqual({ created: false });
    expect(calls.some((c) => c.method === "PUT" && c.url.endsWith("/rec9"))).toBe(
      true,
    );
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
