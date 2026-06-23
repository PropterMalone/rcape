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
  collectReadableUrls,
  validateCaseHint,
} from "./caseHint.js";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

interface GenerateContentResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
}

// Best-effort extract of a JSON object from free-text model output. The
// url_context tool cannot be combined with responseMimeType:"application/json"
// (the API rejects it: "Tool use with a response mime type ... is unsupported"),
// so the link-reading path can't force structured output — it parses what the
// model returns, tolerating a ```json fence or surrounding prose. Returns null
// when no parseable object is present (caller degrades to the prose-only call).
function parseLooseJson(text: string): unknown | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

export class GeminiClient {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
    // url_context fetches+reads remote pages server-side at Google, so it's much
    // slower than a plain prose call — give it a wider deadline.
    private readonly urlTimeoutMs = 25_000,
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

  // url_context variant: let the model READ the given article URLs (party names a
  // headline omits) before answering. Google fetches the pages — not this server
  // — so it adds no SSRF surface here, and only allowlisted requesters reach this
  // path. No responseSchema (the API forbids tool use + JSON mime type), so the
  // answer is parsed leniently; same null-on-any-failure contract as generateJson.
  async generateJsonWithUrls(
    prompt: string,
    urls: string[],
  ): Promise<unknown | null> {
    const url = `${GEMINI_BASE}/${this.model}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
    const full = [
      prompt,
      "",
      "You may read these web pages for facts the posts omit (e.g. the named parties of the lawsuit):",
      ...urls.map((u) => `- ${u}`),
      "",
      'Respond with ONLY a JSON object, no prose and no code fence: {"caption": "Plaintiff v. Defendant" (or, for a bankruptcy / single-party / in re matter with no opposing party, the debtor or subject name alone with no "v.") or null, "courtId": "<id>" or null}.',
    ].join("\n");
    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(this.urlTimeoutMs),
        body: JSON.stringify({
          contents: [{ parts: [{ text: full }] }],
          tools: [{ url_context: {} }],
        }),
      });
      if (!res.ok) {
        console.error(`gemini(url): ${res.status} from ${this.model}`);
        return null;
      }
      const body = (await res.json()) as GenerateContentResponse;
      // url_context responses can split the answer across parts — concatenate.
      const text = (body.candidates?.[0]?.content?.parts ?? [])
        .map((p) => p.text ?? "")
        .join("");
      return parseLooseJson(text);
    } catch (e) {
      console.error(
        `gemini(url): request failed (${e instanceof Error ? e.name : "error"})`,
      );
      return null;
    }
  }
}

// The bot's inferCase seam: prompt → hint. When the mention/thread links a
// readable article (a news card, a court press release), first let url_context
// READ it — a vague "can you pull this one?" over a headline gains the actual
// party names that way. On any failure (no links, paywall, unparseable output)
// it degrades to the prose-only structured-output call, so the no-link path is
// byte-for-byte the prior behavior.
export function inferCaseFactory(
  client: GeminiClient,
): (
  mentionText: string,
  entries: { text: string; links?: string[] }[],
  mentionLinks?: string[],
) => Promise<CaseHint | null> {
  return async (mentionText, entries, mentionLinks) => {
    const prompt = buildCaseHintPrompt(mentionText, entries);
    const urls = collectReadableUrls(mentionLinks, entries);
    if (urls.length > 0) {
      const viaUrl = await client.generateJsonWithUrls(prompt, urls);
      // Only fall through to the prose-only call when url_context FAILED to read
      // (viaUrl === null: no output, paywall, error). A non-null-but-invalid
      // answer means the model DID read the page and produced something that
      // didn't validate — re-asking it the same prompt without the page can't do
      // better, and burns a second Gemini call. So return null in that case.
      if (viaUrl !== null) return validateCaseHint(viaUrl);
    }
    const raw = await client.generateJson(prompt, CASE_HINT_SCHEMA);
    return raw === null ? null : validateCaseHint(raw);
  };
}
