// pattern: Imperative Shell
// The bot's allowlist = the owner (@proptermalone) plus anyone the owner follows
// OR who follows the owner. Membership is checked PER REQUESTER with a single
// app.bsky.graph.getRelationships call (an AppView read, NOT a CourtListener
// call — no 125/day budget), cached per-DID with a short TTL.
//
// This replaced eager enumeration of the owner's entire follows+followers set:
// an owner with thousands of followers (proptermalone has ~9k) overran the page
// cap, so legitimate followers in the tail were silently declined — and the bot
// burned hundreds of paginated graph reads per minute. getRelationships answers
// "is X in either set?" in one call per requester, authoritatively and cheaply.

// Minimal slice of AtpAgent's graph API (mockable in tests). getRelationships
// returns one entry per `others` DID: a Relationship (with `following`/
// `followedBy` AT-URIs when those edges exist) or a NotFoundActor (neither field).
export interface GraphClient {
  app: {
    bsky: {
      graph: {
        getRelationships(params: {
          actor: string;
          others: string[];
        }): Promise<{
          data: {
            relationships: {
              did?: string;
              following?: string; // set when the owner follows this account
              followedBy?: string; // set when this account follows the owner
            }[];
          };
        }>;
      };
    };
  };
}

// Minimal slice of AtpAgent's identity API for one-time owner-handle → DID
// resolution at startup (used for the @proptermalone mention facet).
export interface IdentityClient {
  com: {
    atproto: {
      identity: {
        resolveHandle(params: {
          handle: string;
        }): Promise<{ data: { did: string } }>;
      };
    };
  };
}

// Resolve the owner handle to a DID once at startup. An owner already given as a
// DID (starts with "did:") is returned as-is.
export async function resolveOwnerDid(
  client: IdentityClient,
  ownerHandle: string,
): Promise<string> {
  if (ownerHandle.startsWith("did:")) return ownerHandle;
  const { data } = await client.com.atproto.identity.resolveHandle({
    handle: ownerHandle,
  });
  return data.did;
}

export class AllowlistCache {
  // Per-DID membership decisions with their fetch time, so each requester costs
  // at most one getRelationships call per TTL window.
  private cache = new Map<string, { allowed: boolean; at: number }>();
  // Per-DID in-flight lookup, shared by concurrent callers (single-flight): two
  // has(did) landing together at expiry would otherwise each fire a graph call.
  private inflight = new Map<string, Promise<boolean>>();

  // 60s default: the drain-time re-check is authoritative, so this TTL is just a
  // soft cache that bounds how stale an enqueue-time decision can be. Tunable
  // via RCAPE_ALLOWLIST_TTL_MS at the construction site.
  constructor(
    private readonly client: GraphClient,
    private readonly ownerDid: string,
    private readonly ttlMs = 60 * 1000,
  ) {}

  async has(did: string): Promise<boolean> {
    // The owner is always allowed — they must be able to drive their own bot,
    // and they appear in neither their own follows nor their own followers. The
    // short-circuit also saves a graph call on every owner-driven mention.
    if (did === this.ownerDid) return true;
    const hit = this.cache.get(did);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.allowed;
    const existing = this.inflight.get(did);
    if (existing) return existing;
    const p = this.resolve(did);
    this.inflight.set(did, p);
    try {
      return await p;
    } finally {
      this.inflight.delete(did);
    }
  }

  private async resolve(did: string): Promise<boolean> {
    const { data } = await this.client.app.bsky.graph.getRelationships({
      actor: this.ownerDid,
      others: [did],
    });
    const rel = data.relationships?.[0];
    // Allowed iff the owner follows them OR they follow the owner. A NotFoundActor
    // entry carries neither field, so it correctly resolves to false.
    const allowed =
      rel != null && (rel.following != null || rel.followedBy != null);
    this.cache.set(did, { allowed, at: Date.now() });
    return allowed;
  }
}
