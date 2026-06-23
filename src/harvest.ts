// pattern: Imperative Shell
// Pre-shelve harvest: grows the archive from a PRIVATE, hand-picked set of legal-
// journalist accounts (Karl curates them in .env — never a public list, never
// @-mentioned). Two steps run in the poll loop:
//
//  harvestOnce      — cadence-gated; reads each account's author feed (no CL quota,
//                     AppView) and enqueues the CourtListener dockets they link into
//                     the low-priority pre-shelve queue.
//  preshelveDrainOnce — drains that queue ONLY near the daily reset and ONLY with a
//                     large quota reserve intact, so it spends capacity that would
//                     otherwise sit idle without ever starving a by-request user.
//
// Why near-reset + deferred (not prompt like the watchlist): by late in the UTC day
// the day's by-request demand is known, AND batching the shelving hours after the
// journalist's post DECORRELATES shelving-time from post-time — so nobody can infer
// "Ape watches X" from timing. That decorrelation is why this path needs no consent
// (it never surfaces the source), unlike the consent-gated watchlist sweeper.
//
// NOTE ON "RESET": the daily counter resets at UTC midnight (today() = UTC date),
// but CL's real limit is the ROLLING 24h window (selectToken honors both). So the
// near-reset window is a TIMING heuristic, not free capacity — the HIGH selectToken
// floor on the rolling window is the actual guard.

import { type ProvisionedAnnouncement, announceProvision } from "./announce.js";
import type { BotAgent } from "./botAgent.js";
import { buildCaseCard } from "./card.js";
import { truncate } from "./companionPost.js";
import { mentionFacets } from "./facet.js";
import {
  HARVEST_FLOOR_DEFAULT,
  type Ledger,
  findCase,
  loadLedger,
  mutateLedger,
  recordHarvestSwept,
  selectToken,
} from "./ledger.js";
import { parseDocketLink } from "./mention.js";
import {
  enqueuePreshelve,
  findPreshelveJob,
  loadPreshelveQueue,
  markPreshelveDone,
  markPreshelveFailed,
  mutatePreshelveQueue,
  pendingPreshelve,
} from "./preshelveQueue.js";
import {
  type ProvisionConfig,
  type ProvisionResult,
  runProvision,
} from "./provisionCase.js";
import { type StrongRef, findJob, loadQueue, nextDrainable } from "./queue.js";

// How long an account feed rests before re-harvest (AppView politeness; the signal
// moves on a news cycle, not by the minute).
const HARVEST_INTERVAL_MS = Number(
  process.env.RCAPE_HARVEST_INTERVAL_MS ?? 3 * 60 * 60 * 1000,
);
// The drain runs only within this window before UTC midnight (the daily-counter
// reset ≈ 8pm ET in EDT). Default: the last 3h of the UTC day.
const HARVEST_DRAIN_WINDOW_MS = Number(
  process.env.RCAPE_HARVEST_DRAIN_WINDOW_MS ?? 3 * 60 * 60 * 1000,
);
// selectToken `need` for a pre-shelve provision: a HIGH reserve so discretionary
// work only ever uses comfortable surplus and never the budget a by-request user
// (or overnight requests) will need. Far above MIN_QUOTA_FOR_CASE (12).
const HARVEST_FLOOR = Number(
  process.env.RCAPE_HARVEST_FLOOR ?? HARVEST_FLOOR_DEFAULT,
);
// At most this many pre-shelve cases per drain cycle.
const HARVEST_MAX_PER_DRAIN = Number(
  process.env.RCAPE_HARVEST_MAX_PER_DRAIN ?? 3,
);
// Bound how many new dockets one harvest sweep can enqueue (defensive).
const HARVEST_MAX_ENQUEUE = Number(process.env.RCAPE_HARVEST_MAX_ENQUEUE ?? 20);
const FEED_LIMIT = 100;

export interface HarvestConfig {
  // Resolved DIDs of the private source accounts. Empty ⇒ feature off.
  accounts: string[];
  intervalMs?: number;
  drainWindowMs?: number;
  floor?: number;
  maxPerDrain?: number;
}

export interface HarvestDeps {
  agent: Pick<BotAgent, "getAuthorFeed" | "createRecord" | "reply">;
  cfg: ProvisionConfig;
  harvest?: HarvestConfig;
  // Set whenever harvest is armed; the functions no-op if absent.
  preshelveQueuePath?: string;
  queuePath: string; // by-request queue, for cross-dedup + the idle gate
  cardThumb?: unknown;
  announce?: boolean;
  // DIDs whose harvested cases get a one-time courtesy reply under the triggering
  // post when shelved (Chris Geidner's carve-out). Empty/absent ⇒ no source reply.
  notifyThreadDids?: string[];
  provision?: (id: number, cfg: ProvisionConfig) => Promise<ProvisionResult>;
}

export interface HarvestSeams {
  now?: () => number;
}

// pattern: Functional Core
// ms from `nowMs` to the next UTC midnight (the daily-counter reset boundary).
export function msUntilUtcMidnight(nowMs: number): number {
  const d = new Date(nowMs);
  const next = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() + 1,
  );
  return next - nowMs;
}

const utcDay = (nowMs: number): string =>
  new Date(nowMs).toISOString().slice(0, 10);

// Harvest CL docket links from each source account's feed and enqueue the new ones.
// Cadence-gated; AppView-only (no CL quota). Returns how many were enqueued.
export async function harvestOnce(
  deps: HarvestDeps,
  seams: HarvestSeams = {},
): Promise<{ harvested: number }> {
  const accounts = deps.harvest?.accounts ?? [];
  const preshelveQueuePath = deps.preshelveQueuePath;
  if (accounts.length === 0 || !preshelveQueuePath) return { harvested: 0 };

  const now = seams.now ?? Date.now;
  const nowMs = now();
  const nowIso = new Date(nowMs).toISOString();
  const interval = deps.harvest?.intervalMs ?? HARVEST_INTERVAL_MS;

  const ledger0 = await loadLedger(deps.cfg.ledgerPath);
  const sweptAtMs = Date.parse(ledger0.harvest?.sweptAt ?? "") || 0;
  if (nowMs - sweptAtMs < interval) return { harvested: 0 };

  // Collect (docketId, source) from every account; one bad account never aborts.
  // For a notify-thread source (Chris), also capture the triggering post + thread
  // root so the drain can reply under it once the case shelves.
  const notifyDids = new Set(deps.notifyThreadDids ?? []);
  const found: {
    docketId: number;
    source: string;
    notify?: { post: StrongRef; root: StrongRef };
  }[] = [];
  for (const did of accounts) {
    const isNotify = notifyDids.has(did);
    try {
      const feed = await deps.agent.getAuthorFeed(did, { limit: FEED_LIMIT });
      for (const p of feed.items) {
        const hit = parseDocketLink(p.text ?? "", p.links);
        if (!hit) continue;
        const notify =
          isNotify && p.postRef && p.threadRoot
            ? { post: p.postRef, root: p.threadRoot }
            : undefined;
        found.push({ docketId: hit.docketId, source: did, notify });
      }
    } catch (e) {
      console.error(
        `harvest: getAuthorFeed failed for ${did}:`,
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  // Stamp the cadence marker after reading (bounds feed reads to one per interval).
  // The mutate touches only harvest.sweptAt, so ledger0's `cases` are still current
  // for the dedup pass below — reuse it instead of a second loadLedger.
  await mutateLedger(deps.cfg.ledgerPath, (l) => recordHarvestSwept(l, nowIso));

  // Enqueue the new dockets: skip already-shelved (findCase), already in the
  // by-request queue (findJob), or already in the pre-shelve queue. The append
  // goes through the locked mutate (not a bare save) so it stays symmetric with the
  // drain's writes — a future second writer can't clobber it. Bound the batch.
  const byRequest = await loadQueue(deps.queuePath);
  let harvested = 0;
  await mutatePreshelveQueue(preshelveQueuePath, (q0) => {
    let pq = q0;
    const seen = new Set<number>();
    for (const { docketId, source, notify } of found) {
      if (harvested >= HARVEST_MAX_ENQUEUE) break;
      if (seen.has(docketId)) continue;
      seen.add(docketId);
      if (findCase(ledger0, docketId)) continue;
      if (findJob(byRequest, docketId)) continue;
      if (findPreshelveJob(pq, docketId)) continue;
      pq = enqueuePreshelve(pq, {
        docketId,
        source,
        discoveredAt: nowIso,
        status: "pending",
        ...(notify ? { notify } : {}),
      });
      harvested += 1;
    }
    return pq;
  });
  if (harvested > 0) {
    console.log(`harvest: enqueued ${harvested} pre-shelve case(s)`);
  }
  return { harvested };
}

// Drain the pre-shelve queue opportunistically: only near the daily reset, only
// when by-request work is idle, and only while a token keeps a large reserve. Each
// new provision is announced (Feature B). Returns how many were newly provisioned.
export async function preshelveDrainOnce(
  deps: HarvestDeps,
  seams: HarvestSeams = {},
): Promise<{ provisioned: number }> {
  const preshelveQueuePath = deps.preshelveQueuePath;
  if ((deps.harvest?.accounts?.length ?? 0) === 0 || !preshelveQueuePath) {
    return { provisioned: 0 };
  }

  const now = seams.now ?? Date.now;
  const nowMs = now();
  const day = utcDay(nowMs);
  const drainWindow = deps.harvest?.drainWindowMs ?? HARVEST_DRAIN_WINDOW_MS;
  const floor = deps.harvest?.floor ?? HARVEST_FLOOR;
  const maxPerDrain = deps.harvest?.maxPerDrain ?? HARVEST_MAX_PER_DRAIN;

  // Window gate: only within `drainWindow` before UTC midnight.
  if (msUntilUtcMidnight(nowMs) > drainWindow) return { provisioned: 0 };

  // By-request idle gate: if a real request is drainable right now, the prior
  // drain() must have run out of budget — pre-shelve must not compete. Skip.
  const byRequest = await loadQueue(deps.queuePath);
  if (nextDrainable(byRequest, nowMs)) return { provisioned: 0 };

  // Snapshot the pending jobs (oldest first); iterate a fixed list so an error that
  // leaves a job pending doesn't re-loop on it this cycle.
  const q0 = await loadPreshelveQueue(preshelveQueuePath);
  const pending = pendingPreshelve(q0).sort((a, b) =>
    a.discoveredAt < b.discoveredAt
      ? -1
      : a.discoveredAt > b.discoveredAt
        ? 1
        : 0,
  );
  if (pending.length === 0) return { provisioned: 0 };

  const provision = deps.provision ?? ((id, c) => runProvision(id, c));
  let provisioned = 0;
  let attempts = 0;
  for (const job of pending) {
    if (attempts >= maxPerDrain) break;
    const docketId = job.docketId;

    const ledger: Ledger = await loadLedger(deps.cfg.ledgerPath);
    if (findCase(ledger, docketId)) {
      await mutatePreshelveQueue(preshelveQueuePath, (q) =>
        markPreshelveDone(q, docketId),
      );
      continue; // already shelved elsewhere — not an attempt
    }

    // HIGH-floor budget gate on the rolling window (the real guard). None → stop.
    if (!selectToken(ledger, deps.cfg.tokens, day, floor, nowMs)) break;

    attempts += 1;
    let result: ProvisionResult;
    try {
      result = await provision(docketId, deps.cfg);
    } catch (e) {
      console.error(
        `preshelve: docket ${docketId} provision threw:`,
        e instanceof Error ? e.message : String(e),
      );
      continue; // leave pending; retry a later window
    }

    if (result.status === "provisioned") {
      await mutatePreshelveQueue(preshelveQueuePath, (q) =>
        markPreshelveDone(q, docketId),
      );
      await announceProvision(
        {
          agent: deps.agent,
          cardThumb: deps.cardThumb,
          announce: deps.announce,
        },
        result,
      );
      // Notify-thread carve-out (Chris): one courtesy reply UNDER his triggering
      // post. The sole bot post ever made into his thread — fired here, once. The
      // job is already markPreshelveDone (durable) and never reprocessed, so this
      // is at-most-once even across a restart. Best-effort: never fail the shelve.
      if (job.notify) {
        await notifyTriggerThread(deps, job.notify, result);
      }
      provisioned += 1;
      console.log(
        `preshelve: auto-shelved docket ${docketId} (@${result.handle})`,
      );
    } else if (result.status === "exists") {
      await mutatePreshelveQueue(preshelveQueuePath, (q) =>
        markPreshelveDone(q, docketId),
      );
    } else if (
      result.status === "throttled" ||
      result.status === "quota-exhausted"
    ) {
      break; // budget closed — the rest roll to a later window
    } else if (result.status === "not-found") {
      await mutatePreshelveQueue(preshelveQueuePath, (q) =>
        markPreshelveFailed(q, docketId),
      );
    } else {
      // "error" / "dry-run" — leave pending, retry a later window.
      console.log(
        `preshelve: docket ${docketId} not shelved (${result.status})`,
      );
    }
  }
  return { provisioned };
}

// The notify-thread carve-out's single in-thread post: a courtesy reply UNDER the
// triggering post (parent = the post, root = its thread root) telling the source a
// case they linked is now shelved + linking the case account. Best-effort — a post
// failure is logged and swallowed so it never fails the shelve. This is the ONLY
// place the harvest replies in-thread; every other bot post into such a thread is
// re-routed to a new thread (bot.ts), so the source's notifications light up once.
async function notifyTriggerThread(
  deps: HarvestDeps,
  notify: { post: StrongRef; root: StrongRef },
  result: ProvisionedAnnouncement,
): Promise<void> {
  try {
    const name = truncate(result.caseName?.trim() || "the docket", 180);
    const text = `📚 Shelved: ${name}. Follow @${result.handle} — every filing on this docket now publishes to Bluesky.`;
    const card = buildCaseCard(
      {
        handle: result.handle,
        caseName: result.caseName,
        docketNumber: result.docketNumber,
        courtName: result.courtName,
        filings: result.published,
      },
      deps.cardThumb,
    );
    await deps.agent.reply(
      notify.post,
      notify.root,
      text,
      mentionFacets(text, { [result.handle]: result.did }),
      card,
    );
    console.log(`preshelve: notified trigger thread for @${result.handle}`);
  } catch (e) {
    console.error(
      `preshelve: trigger-thread notify failed for @${result.handle}:`,
      e instanceof Error ? e.message : String(e),
    );
  }
}
