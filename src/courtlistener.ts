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

// Longest a single 429 cooldown we'll sleep through inline. A brief 5/min blip
// (a few seconds) is worth waiting out; the hourly/daily window (hundreds to
// thousands of seconds) is not — sleeping it would freeze the bot's single drain
// loop for many minutes (head-of-line blocking the whole queue). Past this cap we
// throw ThrottledError so the caller can defer the case and free the queue.
const MAX_429_WAIT_MS = 90_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// A CourtListener 429 whose cooldown is too long to sleep through inline. Carries
// the server-reported wait so the caller can schedule a retry near the window's
// reopening instead of hammering.
export class ThrottledError extends Error {
  constructor(readonly retryAfterMs: number) {
    super(
      `CourtListener rate-limited; retry after ~${Math.round(retryAfterMs / 1000)}s`,
    );
    this.name = "ThrottledError";
  }
}

// Options for resumable pagination. `resumeFrom` (a saved `next` cursor) starts
// mid-list; `onPage` observes each page so the caller can checkpoint progress.
export interface PageOpts<T> {
  resumeFrom?: string | null;
  onPage?: (results: T[], next: string | null) => Promise<void>;
}

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
        // A long cooldown is the hourly/daily window — don't block the drain loop
        // for it; surface it so the case is deferred and the queue moves on.
        if (cooldownMs > MAX_429_WAIT_MS) throw new ThrottledError(cooldownMs);
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

  // Resumable, observable pagination. `resumeFrom` starts at a saved `next` cursor
  // (an absolute CL URL from a prior page — flows through get()'s origin pin like
  // any other) instead of the first path; `onPage` fires after each page with that
  // page's results and the post-page cursor, so a caller can checkpoint progress.
  // Returns the post-loop `next`: NULL means the list is exhausted, NON-NULL means
  // MAX_PAGES was hit this call — a per-WINDOW politeness cap, not a per-case
  // total. A resumed call continues past it, so a big docket is no longer capped
  // at MAX_PAGES*page_size entries.
  private async getAllPages<T>(
    firstPath: string,
    opts: PageOpts<T> = {},
  ): Promise<{ results: T[]; next: string | null }> {
    const out: T[] = [];
    let next: string | null =
      opts.resumeFrom !== undefined ? opts.resumeFrom : firstPath;
    let pages = 0;
    while (next && pages < MAX_PAGES) {
      const page: ClPage<T> = await this.get<ClPage<T>>(next);
      out.push(...page.results);
      next = page.next;
      pages += 1;
      await opts.onPage?.(page.results, next);
    }
    return { results: out, next };
  }

  // Resumable entry/party fetch (used by the checkpointed provisioner). The
  // returned `next` is the resume cursor for the next window (null = complete).
  fetchDocketEntries(
    docketId: number,
    opts?: PageOpts<ClDocketEntry>,
  ): Promise<{ results: ClDocketEntry[]; next: string | null }> {
    return this.getAllPages<ClDocketEntry>(
      `/docket-entries/?docket=${docketId}&page_size=100&order_by=recap_sequence_number`,
      opts,
    );
  }
  fetchParties(
    docketId: number,
    opts?: PageOpts<ClParty>,
  ): Promise<{ results: ClParty[]; next: string | null }> {
    return this.getAllPages<ClParty>(
      `/parties/?docket=${docketId}&page_size=100`,
      opts,
    );
  }

  // Non-resumable shims: fetch every page in one shot (the offline CAR builder and
  // tests that don't model windowing). A small docket fits well under MAX_PAGES.
  async getAllDocketEntries(docketId: number): Promise<ClDocketEntry[]> {
    return (await this.fetchDocketEntries(docketId)).results;
  }
  async getAllParties(docketId: number): Promise<ClParty[]> {
    return (await this.fetchParties(docketId)).results;
  }

  // Fetch ONLY docket entries newer than `sinceSeq` (a recap_sequence_number
  // high-water), newest-first via descending order with early-stop: as soon as a
  // page yields an entry at or below the water line, every later entry is older
  // too, so we stop. The watched-case monitor therefore pays ~1 CL call when a
  // docket has nothing new (the common case) instead of re-paging the whole
  // docket. Entries with no sequence number are skipped (can't be ordered) but
  // don't trigger the stop. Returned newest-first.
  async fetchDocketEntriesSince(
    docketId: number,
    sinceSeq: string,
  ): Promise<ClDocketEntry[]> {
    const out: ClDocketEntry[] = [];
    let next: string | null =
      `/docket-entries/?docket=${docketId}&page_size=100&order_by=-recap_sequence_number`;
    let pages = 0;
    while (next && pages < MAX_PAGES) {
      const page: ClPage<ClDocketEntry> =
        await this.get<ClPage<ClDocketEntry>>(next);
      let reachedOld = false;
      for (const e of page.results) {
        const seq = e.recap_sequence_number;
        if (seq == null) continue; // unorderable — skip, but keep scanning
        if (seq.localeCompare(sinceSeq) > 0) {
          out.push(e); // strictly newer than the water line
        } else {
          reachedOld = true; // ≤ water line → all remaining are older
          break;
        }
      }
      if (reachedOld) break;
      next = page.next;
      pages += 1;
    }
    return out;
  }
}
