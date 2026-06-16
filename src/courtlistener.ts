// pattern: Imperative Shell
// Thin client over the CourtListener REST v4 API. Mockable via fetchImpl.
// Self-throttles to respect the free tier's 5 requests/minute limit and retries
// on 429 using the server-advertised cooldown.

import type {
  ClDocket,
  ClDocketEntry,
  ClPage,
  ClParty,
  ClSearchDocket,
  ClSearchPage,
} from "./courtlistener.types.js";

// Parse the configured CourtListener token pool. COURTLISTENER_API_TOKENS
// (comma-separated) is the pool; the legacy single COURTLISTENER_API_TOKEN is
// the fallback, so existing one-token deployments keep working unchanged. Each
// token carries its own 125/day budget — adding tokens raises the ceiling.
export function parseClTokens(env: NodeJS.ProcessEnv = process.env): string[] {
  const multi = (env.COURTLISTENER_API_TOKENS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (multi.length > 0) return [...new Set(multi)];
  const single = env.COURTLISTENER_API_TOKEN?.trim();
  if (single) return [single];
  throw new Error(
    "COURTLISTENER_API_TOKENS (or COURTLISTENER_API_TOKEN) not set",
  );
}

const BASE = "https://www.courtlistener.com/api/rest/v4";
// Every request carries the API token in an Authorization header, so an absolute
// URL (the response-body `next` pagination link) must be pinned to this origin —
// a crafted/compromised `next` pointing elsewhere would leak the token.
const CL_ORIGIN = new URL(BASE).origin; // https://www.courtlistener.com
const MAX_PAGES = 50;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class CourtListenerClient {
  private lastRequestAt = 0;
  private _requestCount = 0;

  /**
   * Raw CL API calls issued — one per get(), including each pagination page;
   * excludes 429 retries. CourtListener's 125/day cap counts raw calls, so this
   * is the right figure for quota accounting.
   */
  get requestCount(): number {
    return this._requestCount;
  }

  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    // ~4.6 req/min, comfortably under the 5/min free-tier cap
    private readonly minIntervalMs = 13_000,
  ) {}

  private async throttle(): Promise<void> {
    const wait = this.minIntervalMs - (Date.now() - this.lastRequestAt);
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();
  }

  private async get<T>(path: string): Promise<T> {
    let url: string;
    if (path.startsWith("http")) {
      // An absolute URL only ever comes from a response `next` link. Pin it to
      // CourtListener's origin before attaching the token (SSRF / token-leak).
      const parsed = new URL(path);
      if (parsed.origin !== CL_ORIGIN) {
        throw new Error(
          `CourtListener: refusing to follow off-host URL (${parsed.origin}); pagination must stay on ${CL_ORIGIN}`,
        );
      }
      url = path;
    } else {
      url = `${BASE}${path}`;
    }
    this._requestCount += 1;
    for (let attempt = 0; attempt < 5; attempt++) {
      await this.throttle();
      const res = await this.fetchImpl(url, {
        headers: {
          Authorization: `Token ${this.token}`,
          Accept: "application/json",
        },
      });
      if (res.status === 429) {
        const body = await res.text();
        const m = body.match(/available in (\d+) seconds/);
        const cooldownMs = (m ? Number(m[1]) + 2 : 15) * 1000;
        await sleep(cooldownMs);
        continue;
      }
      if (!res.ok) {
        throw new Error(
          `CourtListener ${res.status} for ${path}: ${await res.text()}`,
        );
      }
      return (await res.json()) as T;
    }
    throw new Error(`CourtListener: retries exhausted for ${path}`);
  }

  getDocket(id: number): Promise<ClDocket> {
    return this.get<ClDocket>(`/dockets/${id}/`);
  }

  // One page only, never paginate: a search is exactly one quota call, and the
  // v1b gate only needs `count` (on page 1) plus the first result. The caption
  // must already be sanitized (validateCaseHint) — it lands inside a quoted
  // caseName phrase operator.
  async searchDockets(
    caption: string,
    courtId?: string,
  ): Promise<ClSearchPage> {
    const params = new URLSearchParams({
      type: "d",
      q: `caseName:"${caption}"`,
    });
    if (courtId) params.set("court", courtId);
    const page = await this.get<ClPage<ClSearchDocket>>(
      `/search/?${params.toString()}`,
    );
    // Search counts are numbers in practice; the URL-string/null forms belong
    // to the async-count list endpoints. Fall back to the visible page length
    // (page size 20 ≫ 1, so the exactly-one gate stays sound).
    const count =
      typeof page.count === "number" ? page.count : page.results.length;
    return { count, results: page.results };
  }

  // Search by docket number (e.g. "0:26-cr-00115"). One page, one quota call,
  // same shape + count gate as searchDockets — but a far more precise signal than
  // a guessed caption. The number is regex-extracted (parseCaseNumber), so it
  // carries only `[\d:a-z-]` and is safe inside the quoted docketNumber operator.
  async searchByDocketNumber(
    caseNumber: string,
    courtId?: string,
  ): Promise<ClSearchPage> {
    const params = new URLSearchParams({
      type: "d",
      q: `docketNumber:"${caseNumber}"`,
    });
    if (courtId) params.set("court", courtId);
    const page = await this.get<ClPage<ClSearchDocket>>(
      `/search/?${params.toString()}`,
    );
    const count =
      typeof page.count === "number" ? page.count : page.results.length;
    return { count, results: page.results };
  }

  private async getAllPages<T>(firstPath: string): Promise<T[]> {
    const out: T[] = [];
    let next: string | null = firstPath;
    let pages = 0;
    while (next && pages < MAX_PAGES) {
      const page: ClPage<T> = await this.get<ClPage<T>>(next);
      out.push(...page.results);
      next = page.next;
      pages += 1;
    }
    return out;
  }

  getAllDocketEntries(docketId: number): Promise<ClDocketEntry[]> {
    return this.getAllPages<ClDocketEntry>(
      `/docket-entries/?docket=${docketId}&page_size=100&order_by=recap_sequence_number`,
    );
  }

  getAllParties(docketId: number): Promise<ClParty[]> {
    return this.getAllPages<ClParty>(
      `/parties/?docket=${docketId}&page_size=100`,
    );
  }
}
