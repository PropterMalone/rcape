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
});
