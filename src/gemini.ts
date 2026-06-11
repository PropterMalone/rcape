// pattern: Imperative Shell
// Thin client over the Gemini generateContent REST endpoint (no SDK), used for
// v1b case inference. Error contract: null on ANY failure — non-2xx (including
// 429: no retry, the caller degrades to the ask-for-a-link reply), timeout,
// network error, or unparseable output. Never throws: a Gemini hiccup must not
// abort a poll cycle.

import {
  CASE_HINT_SCHEMA,
  type CaseHint,
  buildCaseHintPrompt,
  validateCaseHint,
} from "./caseHint.js";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

interface GenerateContentResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
}

export class GeminiClient {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  async generateJson(prompt: string, schema: object): Promise<unknown | null> {
    // The key rides in the query string per the API's docs; it must never
    // appear in logs — log the status only.
    const url = `${GEMINI_BASE}/${this.model}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: schema,
          },
        }),
      });
      if (!res.ok) {
        console.error(`gemini: ${res.status} from ${this.model}`);
        return null;
      }
      const body = (await res.json()) as GenerateContentResponse;
      const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
      if (typeof text !== "string") return null;
      return JSON.parse(text) as unknown;
    } catch (e) {
      console.error(
        `gemini: request failed (${e instanceof Error ? e.name : "error"})`,
      );
      return null;
    }
  }
}

// The bot's inferCase seam: prompt → structured output → validated CaseHint.
export function inferCaseFactory(
  client: GeminiClient,
): (
  mentionText: string,
  entries: { text: string }[],
) => Promise<CaseHint | null> {
  return async (mentionText, entries) => {
    const raw = await client.generateJson(
      buildCaseHintPrompt(mentionText, entries),
      CASE_HINT_SCHEMA,
    );
    return raw === null ? null : validateCaseHint(raw);
  };
}
