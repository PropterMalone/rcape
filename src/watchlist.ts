// pattern: Imperative Shell
// Watchlist sweeper — auto-shelves cases getting media attention. A curated,
// consent-based Bluesky LIST (app.bsky.graph.list, owned by the operator) of
// legal journalists / court-watchers is the attention signal: when a docket link
// is shared by ≥ threshold distinct list members, the case is provisioned.
//
// Two properties keep this safe + cheap, unlike a news-search approach:
//  1. Only DIRECT CourtListener docket links (/docket/NNNN/) count, parsed by the
//     audited parseDocketLink. Zero caption/name inference — it sidesteps the
//     misdetection class that once auto-provisioned the wrong Hunter-Biden docket.
//  2. Reading the list (getListFeed) costs NO CL quota — it's an AppView read. CL
//     calls are spent only on the actual provision, which is floor-gated + capped.
//
// Runs IN-PROCESS in the poll loop after the monitor (single writer). Self-gated
// by cadence + budget, mirroring monitorOnce: most cycles are a cheap no-op, and
// it provisions only with headroom BEYOND a live by-request case, so a trending
// case never starves someone who actually asked.

import { type RichtextRecord, extractPostLinks } from "./facet.js";
import {
  findCase,
  loadLedger,
  mutateLedger,
  recordWatchlistSwept,
  selectToken,
} from "./ledger.js";
import { parseDocketLink } from "./mention.js";
import {
  type ProvisionConfig,
  type ProvisionResult,
  runProvision,
} from "./provisionCase.js";

// How long between list-feed reads. The signal moves on a news cycle, not by the
// minute, so a generous default keeps AppView reads modest under a 60s poll loop.
const WATCHLIST_INTERVAL_MS = Number(
  process.env.RCAPE_WATCHLIST_INTERVAL_MS ?? 30 * 60 * 1000,
);
// Distinct list members that must share a docket before it trips. Default 1 — with
// a curated, trusted list, one journalist linking a docket already IS the signal.
// Raise to 2+ once the list grows, to require corroboration ("a lot of attention").
const WATCHLIST_THRESHOLD = Number(process.env.RCAPE_WATCHLIST_THRESHOLD ?? 1);
// At most this many cases auto-shelved per sweep, so one trending news day can't
// blow the budget; the rest roll to later sweeps (re-trip while still trending).
const WATCHLIST_MAX_PER_CYCLE = Number(
  process.env.RCAPE_WATCHLIST_MAX_PER_CYCLE ?? 3,
);
// Budget bar to provision a watchlist case: a token must have headroom for THIS
// case (~RESERVED_CALLS_PER_CASE=10) PLUS a full live request (MIN_QUOTA_FOR_CASE
// ≈12) in reserve. Discretionary auto-shelving must never consume the budget a
// by-request user needs. Stricter than runProvision's own internal gate.
//
// SINGLE-TOKEN ASSUMPTION: this gate proves *some* token clears the floor, then
// runProvision independently re-selects a token (need=RESERVED_CALLS_PER_CASE) and
// charges it. With ONE token (today's reality — CourtListener's ToS forbids a 2nd
// token, even via a recruited person) the gate token and the spend token are the
// same, so the reserve is real. With a hypothetical multi-token pool they could
// differ: the gate could clear on token B while runProvision spends token A, so the
// "a by-request user keeps a full case in reserve" guarantee holds only per-token,
// not pool-wide. If a pool is ever introduced, thread the gate's selected token into
// runProvision so the spend honors the same floor.
const WATCHLIST_PROVISION_FLOOR = Number(
  process.env.RCAPE_WATCHLIST_PROVISION_FLOOR ?? 24,
);
// One getListFeed page (≤100 posts) is the rolling window. For a small curated
// list that's days-to-weeks of lookback — plenty, and a single AppView call.
const FEED_LIMIT = 100;

// A list-feed post reduced to what the tally needs. `attributedDid` is the member
// the signal counts FOR: the reposter on a repost (their amplification is the
// signal), else the original author.
export interface WatchPost {
  attributedDid: string;
  links: readonly string[];
  text?: string;
  uri?: string;
  indexedAt?: string;
}
export interface ListFeedResult {
  items: WatchPost[];
}

// A docket the watchlist surfaced, with the distinct members that shared it.
export interface DocketAttention {
  docketId: number;
  accounts: string[];
}

export interface WatchlistConfig {
  // at:// URI of the operator's app.bsky.graph.list. Required — its presence is
  // what arms the feature (absent ⇒ the sweeper is off).
  listUri: string;
  // Optional overrides for the module defaults (used mainly by tests).
  threshold?: number;
  maxPerCycle?: number;
  intervalMs?: number;
  provisionFloor?: number;
}

export interface WatchlistDeps {
  agent: {
    getListFeed(
      listUri: string,
      opts?: { limit?: number },
    ): Promise<ListFeedResult>;
  };
  cfg: ProvisionConfig;
  watchlist?: WatchlistConfig;
  // Provision seam (defaults to runProvision) — the same path the drain uses.
  provision?: (id: number, cfg: ProvisionConfig) => Promise<ProvisionResult>;
}

export interface WatchlistSeams {
  now?: () => number;
}

// pattern: Functional Core
// The member a feed item's attention counts for: the reposter on a repost (their
// boost is the signal), else the original author. Pure so the shell's getListFeed
// mapping is unit-testable.
export function attributedDidOf(
  authorDid: string,
  reason?: { $type?: string; by?: { did?: string } },
): string {
  if (reason?.$type === "app.bsky.feed.defs#reasonRepost" && reason.by?.did) {
    return reason.by.did;
  }
  return authorDid;
}

// The raw shape of one app.bsky.feed.getListFeed item that mapListFeedItem reads.
// Structurally typed (not the full SDK type) so the mapper is unit-testable with
// plain objects and the SDK's wider union is cast to it at the call site.
export interface RawListFeedItem {
  post?: {
    author?: { did?: string };
    record?: unknown;
    uri?: string;
    indexedAt?: string;
  };
  reason?: { $type?: string; by?: { did?: string } };
}

// pattern: Functional Core
// Map one list-feed item to a WatchPost, or null when it carries no usable post.
// A list feed can include deleted/blocked/hydration-failed entries; returning null
// lets the caller skip them with .filter instead of throwing — so one bad item
// can't abort the whole feed read (which the sweep's try/catch would swallow,
// silently suppressing ALL tripping for the cycle). Mirrors getPostThread's
// NotFound/Blocked tolerance. Pure, so the field-extraction wiring is tested here
// rather than only through the live AppView.
export function mapListFeedItem(item: RawListFeedItem): WatchPost | null {
  const post = item.post;
  if (!post?.author?.did) return null;
  const record = (post.record ?? {}) as RichtextRecord & { text?: string };
  return {
    attributedDid: attributedDidOf(post.author.did, item.reason),
    links: extractPostLinks(record),
    text: record.text,
    uri: post.uri,
    indexedAt: post.indexedAt,
  };
}

// pattern: Functional Core
// Tally distinct list members per docket and return those meeting the threshold,
// most-attention first (so the per-cycle cap shelves the hottest cases first). A
// member sharing the same docket twice counts once (Set). One docket per post (the
// audited parseDocketLink takes the first valid /docket/NNNN/ link), which matches
// the conservative "the docket IS the subject" framing for a journalist's post.
export function tallyDocketAttention(
  posts: readonly WatchPost[],
  threshold: number,
): DocketAttention[] {
  const byDocket = new Map<number, Set<string>>();
  for (const p of posts) {
    const hit = parseDocketLink(p.text ?? "", p.links);
    if (!hit) continue;
    let accounts = byDocket.get(hit.docketId);
    if (!accounts) {
      accounts = new Set<string>();
      byDocket.set(hit.docketId, accounts);
    }
    accounts.add(p.attributedDid);
  }
  const out: DocketAttention[] = [];
  for (const [docketId, accounts] of byDocket) {
    if (accounts.size >= threshold) {
      out.push({ docketId, accounts: [...accounts] });
    }
  }
  return out.sort((a, b) => b.accounts.length - a.accounts.length);
}

// One watchlist sweep: read the list feed, tally attention, and auto-shelve tripped
// dockets that aren't already known — budget-gated + capped. Called from pollOnce
// after the monitor. Returns the count of newly provisioned cases (for the
// directory-regeneration trigger). Best-effort: the caller wraps it so a failure
// never aborts the poll cycle.
export async function watchlistSweepOnce(
  deps: WatchlistDeps,
  seams: WatchlistSeams = {},
): Promise<{ provisioned: number; tripped: number }> {
  const wl = deps.watchlist;
  if (!wl?.listUri) return { provisioned: 0, tripped: 0 };

  const now = seams.now ?? Date.now;
  const nowMs = now();
  const nowIso = new Date(nowMs).toISOString();
  const day = nowIso.slice(0, 10);
  const cfg = deps.cfg;
  const interval = wl.intervalMs ?? WATCHLIST_INTERVAL_MS;
  // Clamp to >=1 as defensive hygiene. (Today threshold 0 already behaves as 1:
  // a docket only enters the tally when a post links it, so accounts.size is always
  // >=1 and `>= 0` trips the same set. The clamp guards against a future tally
  // change where a 0/negative value would mean "match regardless of accounts," and
  // makes the floor explicit for an operator who sets the var to 0 expecting "off.")
  const threshold = Math.max(1, wl.threshold ?? WATCHLIST_THRESHOLD);
  const maxPerCycle = wl.maxPerCycle ?? WATCHLIST_MAX_PER_CYCLE;
  const provisionFloor = wl.provisionFloor ?? WATCHLIST_PROVISION_FLOOR;

  // Cadence gate: re-read the feed only after a full interval (AppView politeness).
  const ledger0 = await loadLedger(cfg.ledgerPath);
  const sweptAtMs = Date.parse(ledger0.watchlist?.sweptAt ?? "") || 0;
  if (nowMs - sweptAtMs < interval) return { provisioned: 0, tripped: 0 };

  let feed: ListFeedResult;
  try {
    feed = await deps.agent.getListFeed(wl.listUri, { limit: FEED_LIMIT });
  } catch (e) {
    console.error(
      "watchlist: getListFeed failed:",
      e instanceof Error ? e.message : String(e),
    );
    return { provisioned: 0, tripped: 0 };
  }

  // Commit to this interval even if every provision is later budget-skipped — the
  // dockets stay trending and re-trip next interval; this just bounds feed reads.
  await mutateLedger(cfg.ledgerPath, (l) => recordWatchlistSwept(l, nowIso));

  const tripped = tallyDocketAttention(feed.items, threshold);
  if (tripped.length === 0) return { provisioned: 0, tripped: 0 };

  const provision = deps.provision ?? ((id, c) => runProvision(id, c));
  let provisioned = 0;
  let attempts = 0;
  for (const { docketId, accounts } of tripped) {
    if (attempts >= maxPerCycle) break;

    // Re-read fresh for live quota + the latest case set (a concurrent drain may
    // have just shelved this docket).
    const fresh = await loadLedger(cfg.ledgerPath);
    // Skip ANY docket the bot already knows — the watchlist discovers NEW cases;
    // the drain + monitor own existing/zombie ones. (findCase covers completed and
    // in-flight alike, so the sweeper never resumes someone else's half-done work.)
    if (findCase(fresh, docketId)) continue;

    // Budget floor gate: only spend when a live request's worth of budget remains
    // beyond this case. If no token qualifies, stop — the rest roll to a later
    // sweep (still trending). nowMs engages the predictive rolling-window gate.
    const token = selectToken(fresh, cfg.tokens, day, provisionFloor, nowMs);
    if (!token) break;

    attempts += 1;
    let result: ProvisionResult;
    try {
      result = await provision(docketId, cfg);
    } catch (e) {
      console.error(
        `watchlist: docket ${docketId} provision failed:`,
        e instanceof Error ? e.message : String(e),
      );
      continue;
    }

    if (result.status === "provisioned") {
      provisioned += 1;
      console.log(
        `watchlist: auto-shelved docket ${docketId} (@${result.handle}) — ${accounts.length} watchlist mention(s)`,
      );
    } else if (
      result.status === "quota-exhausted" ||
      result.status === "throttled"
    ) {
      // Budget closed mid-cycle (a race past the gate, or a bigger-than-reserved
      // docket) — stop; the rest roll to a later sweep.
      break;
    } else {
      console.log(
        `watchlist: docket ${docketId} not shelved (${result.status})`,
      );
    }
  }
  return { provisioned, tripped: tripped.length };
}
