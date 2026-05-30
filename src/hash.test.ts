import { describe, expect, it, vi } from "vitest";
import { hashDocuments } from "./hash.js";

function makeOkFetch(content: string) {
  return vi.fn().mockResolvedValue({
    ok: true,
    arrayBuffer: () =>
      Promise.resolve(new TextEncoder().encode(content).buffer),
  });
}

describe("hashDocuments", () => {
  it("deduplicates: fetches a URL only once even when supplied twice", async () => {
    const fetchStub = makeOkFetch("bytes");
    const urls = ["https://example.com/a.pdf", "https://example.com/a.pdf"];
    const result = await hashDocuments(
      urls,
      fetchStub as unknown as typeof fetch,
    );
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(result.size).toBe(1);
  });

  it("omits the URL when the response is not ok", async () => {
    const fetchStub = vi.fn().mockResolvedValue({ ok: false });
    const result = await hashDocuments(
      ["https://example.com/missing.pdf"],
      fetchStub as unknown as typeof fetch,
    );
    expect(result.size).toBe(0);
  });

  it("omits the URL when fetch throws", async () => {
    const fetchStub = vi.fn().mockRejectedValue(new Error("network error"));
    const result = await hashDocuments(
      ["https://example.com/error.pdf"],
      fetchStub as unknown as typeof fetch,
    );
    expect(result.size).toBe(0);
  });
});
