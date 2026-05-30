// pattern: Imperative Shell
// Thin client over the CourtListener REST v4 API. Mockable via fetchImpl.
// Self-throttles to respect the free tier's 5 requests/minute limit and retries
// on 429 using the server-advertised cooldown.

import type {
  ClDocket,
  ClDocketEntry,
  ClPage,
  ClParty,
} from "./courtlistener.types.js";

const BASE = "https://www.courtlistener.com/api/rest/v4";
const MAX_PAGES = 50;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class CourtListenerClient {
  private lastRequestAt = 0;
  private _requestCount = 0;

  /** Logical CL requests issued (for quota accounting); excludes 429 retries. */
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
    const url = path.startsWith("http") ? path : `${BASE}${path}`;
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
