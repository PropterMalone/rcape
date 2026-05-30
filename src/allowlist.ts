// pattern: Imperative Shell
// Resolves the bot's allowlist = the union of who the owner (@proptermalone)
// follows and who follows them. These are AppView graph reads, NOT CourtListener
// calls, so they don't touch the 125/day budget. Cached with a short TTL.

// Minimal slice of AtpAgent's graph API (mockable in tests).
export interface GraphClient {
  app: {
    bsky: {
      graph: {
        getFollows(params: {
          actor: string;
          limit?: number;
          cursor?: string;
        }): Promise<{ data: { follows: { did: string }[]; cursor?: string } }>;
        getFollowers(params: {
          actor: string;
          limit?: number;
          cursor?: string;
        }): Promise<{
          data: { followers: { did: string }[]; cursor?: string };
        }>;
      };
    };
  };
}

async function collectDids(
  page: (cursor?: string) => Promise<{ dids: string[]; cursor?: string }>,
): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  let guard = 0;
  do {
    const res = await page(cursor);
    out.push(...res.dids);
    cursor = res.cursor;
  } while (cursor && ++guard < 100);
  return out;
}

export async function resolveAllowlist(
  client: GraphClient,
  actor: string,
): Promise<Set<string>> {
  const follows = await collectDids(async (cursor) => {
    const { data } = await client.app.bsky.graph.getFollows({
      actor,
      limit: 100,
      cursor,
    });
    return { dids: data.follows.map((f) => f.did), cursor: data.cursor };
  });
  const followers = await collectDids(async (cursor) => {
    const { data } = await client.app.bsky.graph.getFollowers({
      actor,
      limit: 100,
      cursor,
    });
    return { dids: data.followers.map((f) => f.did), cursor: data.cursor };
  });
  return new Set([...follows, ...followers]);
}

export class AllowlistCache {
  private dids = new Set<string>();
  private fetchedAt = 0;

  constructor(
    private readonly client: GraphClient,
    private readonly actor: string,
    private readonly ttlMs = 5 * 60 * 1000,
  ) {}

  async has(did: string): Promise<boolean> {
    await this.ensureFresh();
    return this.dids.has(did);
  }

  async ensureFresh(): Promise<void> {
    if (this.fetchedAt > 0 && Date.now() - this.fetchedAt < this.ttlMs) return;
    this.dids = await resolveAllowlist(this.client, this.actor);
    this.fetchedAt = Date.now();
  }
}
