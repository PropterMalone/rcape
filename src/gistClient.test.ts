import { describe, expect, it, vi } from "vitest";
import { updateGist } from "./gistClient.js";

describe("updateGist", () => {
  it("PATCHes the gist with the file content and a bearer token", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const res = await updateGist(
      "tok-123",
      "GISTID",
      "directory.md",
      "# table",
      fetchImpl as unknown as typeof fetch,
    );
    expect(res.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.github.com/gists/GISTID");
    expect(init.method).toBe("PATCH");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer tok-123",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      files: { "directory.md": { content: "# table" } },
    });
  });

  it("returns ok:false with the status AND body slice (so 401 vs 404 is distinguishable)", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("Not Found: no such gist", { status: 404 }),
    );
    const res = await updateGist(
      "t",
      "g",
      "f",
      "c",
      fetchImpl as unknown as typeof fetch,
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("404");
    // The body distinguishes a bad id (404) from a bad token (401) in the log.
    expect(res.error).toContain("Not Found: no such gist");
  });

  it("returns ok:false (does not throw) when fetch rejects", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const res = await updateGist(
      "t",
      "g",
      "f",
      "c",
      fetchImpl as unknown as typeof fetch,
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("network down");
  });
});
