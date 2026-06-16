import { describe, expect, it, vi } from "vitest";
import { CASE_HINT_SCHEMA } from "./caseHint.js";
import { GeminiClient, inferCaseFactory } from "./gemini.js";

function res(status: number, body: unknown): Response {
  return {
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const candidate = (text: string): unknown => ({
  candidates: [{ content: { parts: [{ text }] } }],
});

describe("GeminiClient.generateJson", () => {
  it("POSTs structured-output config and parses the candidate JSON", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return res(200, candidate('{"caption":"A v. B","courtId":null}'));
    });
    const client = new GeminiClient(
      "test-key",
      "gemini-2.5-flash-lite",
      fetchImpl as unknown as typeof fetch,
    );
    const out = await client.generateJson("the prompt", CASE_HINT_SCHEMA);
    expect(out).toEqual({ caption: "A v. B", courtId: null });

    const { url, init } = calls[0] as { url: string; init: RequestInit };
    expect(url).toContain("gemini-2.5-flash-lite:generateContent");
    expect(url).toContain("key=test-key");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.contents[0].parts[0].text).toBe("the prompt");
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseSchema).toEqual(CASE_HINT_SCHEMA);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns null on 429 without retrying (degrade, don't back off)", async () => {
    const fetchImpl = vi.fn(async () => res(429, { error: "rate limited" }));
    const client = new GeminiClient(
      "k",
      "m",
      fetchImpl as unknown as typeof fetch,
    );
    expect(await client.generateJson("p", {})).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns null on a server error", async () => {
    const fetchImpl = vi.fn(async () => res(500, {}));
    const client = new GeminiClient(
      "k",
      "m",
      fetchImpl as unknown as typeof fetch,
    );
    expect(await client.generateJson("p", {})).toBeNull();
  });

  it("returns null when fetch throws (network / abort)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException("timed out", "AbortError");
    });
    const client = new GeminiClient(
      "k",
      "m",
      fetchImpl as unknown as typeof fetch,
    );
    expect(await client.generateJson("p", {})).toBeNull();
  });

  it("returns null when the candidate text is not JSON", async () => {
    const fetchImpl = vi.fn(async () => res(200, candidate("not json")));
    const client = new GeminiClient(
      "k",
      "m",
      fetchImpl as unknown as typeof fetch,
    );
    expect(await client.generateJson("p", {})).toBeNull();
  });

  it("returns null when the response has no candidates", async () => {
    const fetchImpl = vi.fn(async () => res(200, {}));
    const client = new GeminiClient(
      "k",
      "m",
      fetchImpl as unknown as typeof fetch,
    );
    expect(await client.generateJson("p", {})).toBeNull();
  });

  it("never logs the API key on failure", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const fetchImpl = vi.fn(async () => res(500, {}));
      const client = new GeminiClient(
        "super-secret-key",
        "m",
        fetchImpl as unknown as typeof fetch,
      );
      await client.generateJson("p", {});
      const logged = errSpy.mock.calls.flat().map(String).join(" ");
      expect(logged).not.toContain("super-secret-key");
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("inferCaseFactory", () => {
  it("builds the prompt from mention + thread entries and validates the hint", async () => {
    let prompt = "";
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      prompt = JSON.parse(init.body as string).contents[0].parts[0].text;
      return res(
        200,
        candidate('{"caption":"United States v. Smith","courtId":"nysd"}'),
      );
    });
    const infer = inferCaseFactory(
      new GeminiClient("k", "m", fetchImpl as unknown as typeof fetch),
    );
    const hint = await infer("grab the Smith case?", [
      { text: "SDNY indictment dropped today" },
    ]);
    expect(hint).toEqual({
      caption: "United States v. Smith",
      courtId: "nysd",
    });
    expect(prompt).toContain("grab the Smith case?");
    expect(prompt).toContain("SDNY indictment dropped today");
  });

  it("returns null when the model output fails validation", async () => {
    const fetchImpl = vi.fn(async () =>
      res(200, candidate('{"caption":null,"courtId":"nysd"}')),
    );
    const infer = inferCaseFactory(
      new GeminiClient("k", "m", fetchImpl as unknown as typeof fetch),
    );
    expect(await infer("m", [])).toBeNull();
  });

  it("returns null when the client returns null", async () => {
    const fetchImpl = vi.fn(async () => res(429, {}));
    const infer = inferCaseFactory(
      new GeminiClient("k", "m", fetchImpl as unknown as typeof fetch),
    );
    expect(await infer("m", [])).toBeNull();
  });

  it("reads a thread article via url_context when links are present", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      // url_context replies with prose-wrapped JSON, no schema enforcement.
      return res(
        200,
        candidate(
          'Here you go:\n```json\n{"caption":"Kahn v. Anthropic","courtId":"cand"}\n```',
        ),
      );
    });
    const infer = inferCaseFactory(
      new GeminiClient("k", "m", fetchImpl as unknown as typeof fetch),
    );
    const hint = await infer(
      "can you pull this one?",
      [{ text: "Anthropic Sued", links: ["https://on.wsj.com/x"] }],
      [],
    );
    expect(hint).toEqual({ caption: "Kahn v. Anthropic", courtId: "cand" });
    // One call only — the url path succeeded, so no prose-only fallback.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(bodies[0]?.tools).toEqual([{ url_context: {} }]);
    expect(bodies[0]?.generationConfig).toBeUndefined();
  });

  it("falls back to the prose-only schema call when url_context yields nothing (e.g. paywall)", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      call++;
      const body = JSON.parse(init.body as string);
      if (body.tools) {
        // url_context: paywalled → model returns no parseable JSON.
        return res(200, candidate("The article is behind a paywall."));
      }
      // prose-only schema call.
      return res(
        200,
        candidate('{"caption":"Consumer v. Anthropic","courtId":null}'),
      );
    });
    const infer = inferCaseFactory(
      new GeminiClient("k", "m", fetchImpl as unknown as typeof fetch),
    );
    const hint = await infer(
      "pull this",
      [{ text: "news", links: ["https://on.wsj.com/x"] }],
      [],
    );
    expect(hint).toEqual({ caption: "Consumer v. Anthropic", courtId: null });
    expect(call).toBe(2);
  });

  it("skips url_context entirely when there are no readable links", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return res(200, candidate('{"caption":"A v. B","courtId":null}'));
    });
    const infer = inferCaseFactory(
      new GeminiClient("k", "m", fetchImpl as unknown as typeof fetch),
    );
    await infer("plain prose, no link", [{ text: "still no link" }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(bodies[0]?.tools).toBeUndefined();
    expect(bodies[0]?.generationConfig).toBeDefined();
  });
});

describe("GeminiClient.generateJsonWithUrls", () => {
  it("sends url_context (no schema) and parses loose JSON from the answer", async () => {
    const calls: { init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      calls.push({ init });
      return res(200, candidate('{"caption":"X v. Y","courtId":null}'));
    });
    const client = new GeminiClient(
      "k",
      "gemini-2.5-flash-lite",
      fetchImpl as unknown as typeof fetch,
    );
    const out = await client.generateJsonWithUrls("the prompt", [
      "https://x.example/",
    ]);
    expect(out).toEqual({ caption: "X v. Y", courtId: null });
    const body = JSON.parse(calls[0]?.init.body as string);
    expect(body.tools).toEqual([{ url_context: {} }]);
    expect(body.generationConfig).toBeUndefined();
    expect(body.contents[0].parts[0].text).toContain("https://x.example/");
  });

  it("concatenates multi-part answers before parsing", async () => {
    const fetchImpl = vi.fn(async () =>
      res(200, {
        candidates: [
          {
            content: {
              parts: [
                { text: '{"caption":"A v. B"' },
                { text: ',"courtId":null}' },
              ],
            },
          },
        ],
      }),
    );
    const client = new GeminiClient(
      "k",
      "m",
      fetchImpl as unknown as typeof fetch,
    );
    expect(await client.generateJsonWithUrls("p", ["https://x/"])).toEqual({
      caption: "A v. B",
      courtId: null,
    });
  });

  it("returns null on a non-2xx and on unparseable output", async () => {
    const err = new GeminiClient("k", "m", (async () =>
      res(400, {})) as unknown as typeof fetch);
    expect(await err.generateJsonWithUrls("p", ["https://x/"])).toBeNull();
    const noJson = new GeminiClient("k", "m", (async () =>
      res(200, candidate("no json here"))) as unknown as typeof fetch);
    expect(await noJson.generateJsonWithUrls("p", ["https://x/"])).toBeNull();
  });

  it("never logs the API key on failure", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const client = new GeminiClient("super-secret-key", "m", (async () =>
        res(500, {})) as unknown as typeof fetch);
      await client.generateJsonWithUrls("p", ["https://x/"]);
      const logged = errSpy.mock.calls.flat().map(String).join(" ");
      expect(logged).not.toContain("super-secret-key");
    } finally {
      errSpy.mockRestore();
    }
  });
});
