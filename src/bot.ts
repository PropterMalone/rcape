// pattern: Imperative Shell
// The @-mention bot. Polls the bot account's notifications, classifies each
// mention, replies to everyone (ack on accept, decline/no-docket otherwise),
// enqueues provisionable requests, and drains the queue under the CL daily
// budget — posting the "done" reply with the new @handle. `classify` is a pure
// decision function (unit-tested); `pollOnce` is one testable cycle.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { AllowlistCache, resolveOwnerDid } from "./allowlist.js";
import { announceProvision } from "./announce.js";
import { type BotAgent, createBotAgent } from "./botAgent.js";
import type { MentionNotif } from "./botAgent.js";
import { buildCaseCard } from "./card.js";
import type { CaseHint } from "./caseHint.js";
import { BOT_SELF_LABEL } from "./companionPost.js";
import { CourtListenerClient, parseClTokens } from "./courtlistener.js";
import type { ClSearchPage } from "./courtlistener.types.js";
import { regenerateDirectory } from "./directorySync.js";
import { type MentionFacet, mentionFacets } from "./facet.js";
import { GeminiClient, inferCaseFactory } from "./gemini.js";
import {
  type HarvestConfig,
  harvestOnce,
  preshelveDrainOnce,
} from "./harvest.js";
import {
  type Ledger,
  MIN_QUOTA_FOR_CASE,
  chargeAndRecord,
  findCase,
  loadLedger,
  markTokenThrottled,
  mutateLedger,
  quotaRemaining,
  rollingStartableAt,
  selectToken,
  throttledUntilMs,
} from "./ledger.js";
import { parseCaseRef, parseMention } from "./mention.js";
import { monitorOnce } from "./monitor.js";
import {
  type ProvisionConfig,
  type ProvisionResult,
  runProvision,
} from "./provisionCase.js";
import {
  type Job,
  type QueueState,
  type StrongRef,
  enqueue,
  findJob,
  hasSeen,
  isActive,
  loadQueue,
  markDeferredNotified,
  markDone,
  markFailed,
  markRetrying,
  markSeen,
  markThrottled,
  markThrottledNotified,
  mutateQueue,
  nextDrainable,
  perRequesterQueued,
  sanitizeHandle,
  setAck,
} from "./queue.js";
import { OWNER_DISPLAY_HANDLE, buildReply } from "./reply.js";
import {
  type ThreadView,
  collectThreadPosts,
  scanThreadForDocket,
} from "./thread.js";
import { type WatchlistConfig, watchlistSweepOnce } from "./watchlist.js";

// MIN_QUOTA_FOR_CASE (the by-request start floor) now lives in ledger.ts as the
// top rung of the centralized budget-priority ladder — see imports above. Require
// this much free budget before STARTING a case, so one can't begin, exhaust a
// token's shared budget partway, and strand itself half-provisioned.
// CourtListener's retry-after is the AUTHORITY on when we may call again — our
// own day-counter resets on the calendar day, but CL enforces a rolling window,
// so the counter can read "budget left" while CL has us locked (the 2026-06-16
// thrash: we reset at 8pm ET, declared ourselves full of quota, and banged on an
// already-spent limit). So honor CL's value directly and only clamp to a 25h
// sanity ceiling against a pathological header — NOT down to an hour, which
// turned a 10h daily lock into hourly re-attempts that never cleared.
const MAX_THROTTLE_BACKOFF_MS = 25 * 3_600_000;
// A cooldown longer than this is CL's daily window, not the 50/hr one: the
// requester hears "tomorrow" (deferred), not "hang tight" (throttled). Keyed off
// CL's reported cooldown, so it's right even when our day-counter disagrees.
const THROTTLE_HOURLY_CEILING_MS = 3_600_000;
// Max in-flight (queued/retrying) requests per requester. Bounds how much of the
// shared daily budget any single allowlisted account can reserve at once (3 ×
// ~17 = ~51 calls), so one user can't monopolize the queue or the quota.
const PER_REQUESTER_CAP = 3;

// Matches the owner's launch-announcement post so the bot acknowledges it with a
// bare "Ook." rather than the no-docket nudge. Owner-gated at the call site;
// tolerant of "R.C. Ape" / "RC Ape" punctuation+spacing.
const ANNOUNCEMENT_MARKER = /announcing\s+r\.?\s*c\.?\s*ape/i;

// Transient provision errors back off and retry rather than failing outright:
// after MAX_PROVISION_RETRIES attempts the job is failed and the requester gets
// an apologetic reply. Backoff grows with the attempt count so a flapping PDS or
// CL hiccup is given time to recover without head-of-line blocking the queue.
const MAX_PROVISION_RETRIES = 3;
const RETRY_BACKOFF_MS: readonly number[] = [60_000, 5 * 60_000, 30 * 60_000]; // 1m, 5m, 30m

// A GitHub gist id is a 20–40 char hex string. Reject anything else at startup so
// a typo'd RCAPE_DIRECTORY_GIST_ID is caught (and the gist push skipped) instead
// of PATCHing /gists/<garbage> on every regenerate.
const GIST_ID_RE = /^[a-f0-9]{20,40}$/i;
function validGistId(id: string | undefined): string | undefined {
  if (id === undefined || id === "") return undefined;
  if (GIST_ID_RE.test(id)) return id;
  console.error(
    `directory: RCAPE_DIRECTORY_GIST_ID is not a valid gist id (${id}); skipping the gist table`,
  );
  return undefined;
}

function backoffMs(retryCount: number): number {
  const i = Math.min(Math.max(0, retryCount - 1), RETRY_BACKOFF_MS.length - 1);
  return RETRY_BACKOFF_MS[i] ?? 60_000;
}

const POST = "app.bsky.feed.post";

// pattern: Functional Core
// The author DID of a thread root from its AT-URI (at://<did>/<collection>/<rkey>).
function rootAuthorDid(uri: string): string | undefined {
  return uri.match(/^at:\/\/([^/]+)\//)?.[1];
}

// Whether a thread is rooted at a notify-thread account (Chris). Such threads get
// AT MOST ONE bot post ever — the harvest's shelve notice; every other bot reply
// that would land here is re-routed to a fresh top-level thread instead.
function isNotifyRooted(
  root: StrongRef,
  notifyDids: string[] | undefined,
): boolean {
  if (!notifyDids?.length) return false;
  const did = rootAuthorDid(root.uri);
  return did !== undefined && notifyDids.includes(did);
}

// Reply to a mention/job normally — UNLESS its thread is notify-rooted, in which
// case post the same content as a NEW top-level thread that @-mentions the engager
// (so they're still notified) rather than threading into the protected thread.
// Returns the posted record's ref (the new post, or the threaded reply).
async function replyOrNewThread(
  deps: BotDeps,
  parent: StrongRef,
  root: StrongRef,
  engager: { handle: string; did: string },
  text: string,
  facets?: MentionFacet[],
  embed?: unknown,
): Promise<StrongRef> {
  if (!isNotifyRooted(root, deps.notifyThreadDids)) {
    return deps.agent.reply(parent, root, text, facets, embed);
  }
  // New thread: append "↪ @handle" so the engager is notified; their mention facet
  // is computed over the full text, while the passed-in facets (which target the
  // unchanged prefix) keep their byte offsets.
  const handle = sanitizeHandle(engager.handle);
  const newText = `${text}\n\n↪ @${handle}`;
  const merged = [
    ...(facets ?? []),
    ...mentionFacets(newText, { [handle]: engager.did }),
  ];
  return deps.agent.createRecord(POST, {
    $type: POST,
    text: newText,
    createdAt: new Date().toISOString(),
    labels: BOT_SELF_LABEL,
    ...(merged.length > 0 ? { facets: merged } : {}),
    ...(embed ? { embed } : {}),
  });
}

export type Action =
  | { kind: "ack-enqueue"; docketId: number }
  | { kind: "ack-queued"; docketId: number; ahead: number }
  | { kind: "reply-exists"; handle: string; did?: string }
  | { kind: "reply-declined" }
  | { kind: "reply-no-docket" }
  // v1b: inference proposed a caption but the CL search didn't verify it as
  // exactly one docket (matches = the search's count: 0 or ≥2).
  | { kind: "reply-suggest"; caption: string; matches: number }
  | { kind: "skip" };

export interface ClassifyInput {
  allowed: boolean;
  parsed: ReturnType<typeof parseMention>;
  existingHandle?: string;
  existingDid?: string;
  alreadyQueued: boolean;
  quotaOk: boolean;
  queueAhead: number;
}

// Pure decision: given the facts about a mention, what should the bot do?
// "Reply to everyone" means decline/no-docket are replies, not silence.
export function classify(input: ClassifyInput): Action {
  if (!input.allowed) return { kind: "reply-declined" };
  if (!("docketId" in input.parsed)) return { kind: "reply-no-docket" };
  if (input.existingHandle) {
    return {
      kind: "reply-exists",
      handle: input.existingHandle,
      did: input.existingDid,
    };
  }
  if (input.alreadyQueued) return { kind: "skip" };
  return input.quotaOk
    ? { kind: "ack-enqueue", docketId: input.parsed.docketId }
    : {
        kind: "ack-queued",
        docketId: input.parsed.docketId,
        ahead: input.queueAhead,
      };
}

export interface BotDeps {
  agent: BotAgent;
  allowlist: AllowlistCache;
  cfg: ProvisionConfig;
  queuePath: string;
  // The owner's (@proptermalone) DID, resolved once at startup, used for the
  // mention facet in the "declined" reply. Optional: when absent, the declined
  // reply still posts — just without the owner facet.
  ownerDid?: string;
  // Seal BlobRef for the reply link-card thumbnail, uploaded once at startup.
  // Optional: absent ⇒ cards render text-only (no thumb).
  cardThumb?: unknown;
  // Watchlist sweeper config (auto-shelve trending cases). Optional: absent ⇒ the
  // sweeper is off, the bot is by-request only. Armed by RCAPE_WATCHLIST_URI.
  watchlist?: WatchlistConfig;
  // Pre-shelve harvest config (private journalist feeds → opportunistic backfill).
  // Optional: absent/empty accounts ⇒ off. Armed by RCAPE_HARVEST_ACCOUNTS.
  harvest?: HarvestConfig;
  // DIDs whose threads get the carve-out: a one-time shelve reply on their post,
  // and all other bot posts re-routed out of their threads (Chris Geidner). Armed
  // by RCAPE_NOTIFY_THREAD_ACCOUNTS; absent ⇒ no source replies, no re-routing.
  notifyThreadDids?: string[];
  // Path to the pre-shelve queue (separate from the by-request queuePath). Set in
  // production main(); optional so the many test deps need not supply it (the
  // harvest functions no-op without it).
  preshelveQueuePath?: string;
  // Announce-on-provision switch (RCAPE_ANNOUNCE_PROVISIONS). Default on; false off.
  announce?: boolean;
  provision?: (
    docketId: number,
    cfg: ProvisionConfig,
  ) => Promise<ProvisionResult>;
  // v1b seams, both optional: absent (no RCAPE_GEMINI_API_KEY) the bot behaves
  // exactly as v1a. inferCase proposes a {caption, courtId} hint from prose;
  // searchDockets verifies it with ONE CL search call under `token`. Both
  // return null on any failure — never throw (a hiccup must not abort a cycle).
  inferCase?: (
    mentionText: string,
    entries: { text: string; links?: string[] }[],
    mentionLinks?: string[],
  ) => Promise<CaseHint | null>;
  searchDockets?: (
    caption: string,
    courtId: string | undefined,
    token: string,
  ) => Promise<ClSearchPage | null>;
  // Independent of Gemini: when the mention names a PACER case number, search CL
  // by docket number (precise) instead of inferring a caption. Always wired (it
  // needs only a CL token), so case-number resolution works even with no Gemini
  // key. Returns null on any failure (degrade to the no-docket reply).
  searchByDocketNumber?: (
    caseNumber: string,
    courtId: string | null,
    token: string,
  ) => Promise<ClSearchPage | null>;
}

const today = (): string => new Date().toISOString().slice(0, 10);

// Persist the bot's authoritative in-memory queue under the advisory lock. The
// bot is the queue's single writer and pollOnce runs serially, so the lock just
// provides mutual exclusion (no re-read-merge needed) while honoring the
// load-then-modify-then-save lock contract documented in queue.ts.
function persistQueue(path: string, q: QueueState): Promise<QueueState> {
  return mutateQueue(path, () => q);
}

// Build mention facets for a reply's text from the handles relevant to it. Each
// reply kind embeds at most one provisioned-case handle (→ caseDid) and/or
// @proptermalone (→ ownerDid); mentionFacets scans the copy and emits a facet
// for each, with correct UTF-8 byte offsets. Unknown handles produce no facet.
function replyFacets(
  text: string,
  deps: BotDeps,
  extra?: { handle: string; did: string },
): MentionFacet[] {
  const dids: Record<string, string> = {};
  if (deps.ownerDid) dids[OWNER_DISPLAY_HANDLE] = deps.ownerDid;
  if (extra) dids[extra.handle] = extra.did;
  return mentionFacets(text, dids);
}

export async function pollOnce(deps: BotDeps): Promise<void> {
  const provision = deps.provision ?? ((id, cfg) => runProvision(id, cfg));
  let queue = await loadQueue(deps.queuePath);
  // Stamp the cycle start: everything listed below was indexed at or before now,
  // so this is a safe seenAt to clear the unread badge with after the cycle.
  const cycleStart = new Date().toISOString();
  // Paginate until we reach an already-processed notification, so a burst of
  // likes/follows can't scroll real mentions off page 1 and drop them.
  const mentions = await deps.agent.listMentions({
    isSeen: (uri) => hasSeen(queue, uri),
  });

  for (const m of mentions) {
    if (m.authorDid === deps.agent.did) continue; // never reply to self (loop guard)
    if (hasSeen(queue, m.uri)) continue;

    // Launch-announcement easter egg: the owner's "Announcing R.C. Ape…" post
    // @-mentions the bot but carries no docket — reply with a clean "Ook."
    // instead of the no-docket nudge. Gated on owner-authored AND the marker, so
    // it never fires for anyone else or for any real request.
    if (
      deps.ownerDid &&
      m.authorDid === deps.ownerDid &&
      ANNOUNCEMENT_MARKER.test(m.text)
    ) {
      await deps.agent.reply({ uri: m.uri, cid: m.cid }, m.root, "Ook.");
      queue = markSeen(queue, m.uri);
      await persistQueue(deps.queuePath, queue);
      continue;
    }

    const action = await classifyMention(m, deps, queue);
    const parent: StrongRef = { uri: m.uri, cid: m.cid };

    // A plain reply (not an explicit @-mention) that yields nothing NEW gets
    // SILENCE, not noise: a "thanks" reply to the bot's "done" post must not draw
    // "I admit only…" / "send me a link" (declined/no-docket), NOR a re-post of the
    // case link the bot already put in this thread (reply-exists) — the docket was
    // resolved from the thread the bot itself replied in. Explicit @-mentions still
    // reply to everyone. ("skip" already posts nothing.)
    const suppressNonActionable = m.source === "reply";

    // The engager whose thread a notify-rooted reply would re-route around.
    const engager = { handle: m.authorHandle, did: m.authorDid };

    if (action.kind === "reply-declined") {
      if (!suppressNonActionable) {
        const text = buildReply({ kind: "declined" });
        await replyOrNewThread(
          deps,
          parent,
          m.root,
          engager,
          text,
          replyFacets(text, deps),
        );
      }
    } else if (action.kind === "reply-no-docket") {
      if (!suppressNonActionable) {
        await replyOrNewThread(
          deps,
          parent,
          m.root,
          engager,
          buildReply({ kind: "no-docket" }),
        );
      }
    } else if (action.kind === "reply-suggest") {
      await replyOrNewThread(
        deps,
        parent,
        m.root,
        engager,
        buildReply({
          kind: "suggest",
          caption: action.caption,
          matches: action.matches,
        }),
      );
    } else if (action.kind === "reply-exists") {
      // Suppress on a reply: re-linking a case the bot already shelved in this
      // thread (the "thank you!" case) is the redundant inline link we don't want.
      if (!suppressNonActionable) {
        const text = buildReply({ kind: "exists", handle: action.handle });
        await replyOrNewThread(
          deps,
          parent,
          m.root,
          engager,
          text,
          action.did
            ? replyFacets(text, deps, {
                handle: action.handle,
                did: action.did,
              })
            : replyFacets(text, deps),
        );
      }
    } else if (action.kind === "ack-enqueue" || action.kind === "ack-queued") {
      const job: Job = {
        docketId: action.docketId,
        requesterDid: m.authorDid,
        // Sanitize the handle from the (untrusted) notification before storing:
        // it lands in logs and reply copy.
        requesterHandle: sanitizeHandle(m.authorHandle),
        mention: parent,
        rootRef: m.root,
        status: "queued",
        createdAt: new Date().toISOString(),
      };
      const res = enqueue(queue, job, { perRequesterCap: PER_REQUESTER_CAP });
      if (res.ok) {
        queue = res.queue;
        // Persist the enqueued job (and the seen marker) BEFORE posting the ack.
        // A crash after the ack but before this save would otherwise lose the
        // job entirely, so on restart the mention re-enqueues and re-acks.
        queue = markSeen(queue, m.uri);
        await persistQueue(deps.queuePath, queue);

        const ackText =
          action.kind === "ack-enqueue"
            ? buildReply({ kind: "ack", docketId: action.docketId })
            : buildReply({
                kind: "queued",
                docketId: action.docketId,
                ahead: action.ahead,
              });
        const ackRef = await replyOrNewThread(
          deps,
          parent,
          m.root,
          engager,
          ackText,
        );
        // The ackRef only refines reply threading; a crash here at worst parents
        // the done-reply on the mention instead of the ack. Persist it best-effort.
        queue = setAck(queue, action.docketId, ackRef);
        await persistQueue(deps.queuePath, queue);
        continue;
      }
      // A `requester-cap` rejection means a real docket the requester asked for
      // wasn't queued — reply so they aren't met with silence (a `duplicate`
      // rejection is a re-mention of an in-flight docket, where silence is fine:
      // the original ack/queued reply already stands). Mark seen below either way.
      if (res.reason === "requester-cap") {
        queue = markSeen(queue, m.uri);
        await persistQueue(deps.queuePath, queue);
        await replyOrNewThread(
          deps,
          parent,
          m.root,
          engager,
          buildReply({
            kind: "over-cap",
            inFlight: perRequesterQueued(queue, m.authorDid),
            docketId: action.docketId,
          }),
        );
        continue;
      }
    } else if (action.kind === "skip") {
      // Docket already queued (a duplicate mention while it's in flight): the
      // original ack/queued reply stands, so just mark seen below — no reply.
    } else {
      // Exhaustiveness guard: a new Action kind without a branch here is a
      // compile error, not a silent fall-through to "mark seen, no reply".
      const _exhaustive: never = action;
      void _exhaustive;
    }

    queue = markSeen(queue, m.uri);
    await persistQueue(deps.queuePath, queue);
  }

  // Clear the account's unread notification badge for everything up to this
  // cycle's start. Best-effort: it's cosmetic (the queue's `seen` set is the
  // authoritative dedupe), so a failure here must not abort the cycle.
  try {
    await deps.agent.updateSeen(cycleStart);
  } catch (e) {
    console.error(
      "updateSeen failed:",
      e instanceof Error ? e.message : String(e),
    );
  }

  const provisioned = await drain(deps, provision);

  // After draining the provision queue, re-check a few already-shelved cases for
  // new filings and append them (makes "follow for new filings" true). Self-gated
  // by cadence + budget, so most cycles are a cheap no-op. Best-effort: a monitor
  // failure must never abort the poll cycle.
  let monitorUpdated = 0;
  try {
    monitorUpdated = (await monitorOnce(deps)).updated;
  } catch (e) {
    console.error("monitor cycle failed:", e instanceof Error ? e.message : e);
  }

  // Sweep the watchlist (auto-shelve trending cases). Self-gated by cadence +
  // budget, runs only when a watchlist is configured. Best-effort: a sweep failure
  // must never abort the poll cycle.
  let watchlistProvisioned = 0;
  if (deps.watchlist?.listUri) {
    try {
      watchlistProvisioned = (await watchlistSweepOnce(deps)).provisioned;
    } catch (e) {
      console.error(
        "watchlist sweep failed:",
        e instanceof Error ? e.message : e,
      );
    }
  }

  // Pre-shelve harvest (private journalist feeds → opportunistic backfill). Two
  // best-effort steps: harvest enqueues (AppView read, cadence-gated), then the
  // drain shelves from the pre-shelve queue ONLY near the daily reset with a large
  // quota reserve intact — so it never competes with a by-request user. Off unless
  // RCAPE_HARVEST_ACCOUNTS is configured (harvestOnce/preshelveDrainOnce self-gate).
  let preshelveProvisioned = 0;
  if (deps.harvest?.accounts?.length) {
    try {
      await harvestOnce(deps);
      preshelveProvisioned = (await preshelveDrainOnce(deps)).provisioned;
    } catch (e) {
      console.error(
        "pre-shelve harvest failed:",
        e instanceof Error ? e.message : e,
      );
    }
  }

  // Regenerate the public directory ONCE per cycle when the shelf changed (a new
  // provision, monitor-added filings, a watchlist auto-shelve, or a pre-shelve).
  // regenerateDirectory is itself best-effort and never throws.
  if (
    provisioned ||
    monitorUpdated > 0 ||
    watchlistProvisioned > 0 ||
    preshelveProvisioned > 0
  ) {
    await regenerateDirectory(deps);
  }
}

async function classifyMention(
  m: MentionNotif,
  deps: BotDeps,
  queue: Awaited<ReturnType<typeof loadQueue>>,
): Promise<Action> {
  let parsed = parseMention(m.text, m.links);
  // When the mention itself carries no docket, scan the thread it replies to for
  // an explicit docket LINK (a free getPostThread call — no LLM, no CL quota).
  // Best-effort: a failed fetch falls through to the no-docket reply, never
  // throws (a thread read must not abort the cycle).
  let thread: ThreadView | null = null;
  if ("kind" in parsed) {
    thread = await deps.agent.getPostThread(m.uri).catch(() => null);
    const hit = thread ? scanThreadForDocket(thread) : null;
    if (hit) parsed = hit;
  }
  // `allowed` is checked BEFORE the search/inference steps: they spend a CL quota
  // call (and Gemini), and must be reserved for allowlisted requesters (the link
  // paths above are free, so they may run for anyone).
  const allowed = await deps.allowlist.has(m.authorDid);
  // Still no docket → if the mention names a PACER case number (e.g.
  // "0:26-cr-00115"), search CL by docket number FIRST: it's a precise signal, so
  // it's cheaper (no Gemini) and more reliable than a guessed caption, and it runs
  // even when Gemini is unarmed. count===1 provisions; any other count (a
  // multi-defendant case shares one number across dockets) degrades to a suggest —
  // we do NOT fall through to Gemini, whose caption guess can't beat an exact
  // number. Charge the search call before issuing it (crash-safe direction).
  if ("kind" in parsed && allowed && deps.searchByDocketNumber) {
    const ref = parseCaseRef(m.text);
    if (ref) {
      const before = await loadLedger(deps.cfg.ledgerPath);
      const token = selectToken(
        before,
        deps.cfg.tokens,
        today(),
        1,
        Date.now(),
      );
      if (token) {
        await mutateLedger(deps.cfg.ledgerPath, (fresh) =>
          chargeAndRecord(fresh, 1, today(), token, Date.now()),
        );
        // courtId scopes bankruptcy numbers (which collide across courts) to one
        // docket; it's null for the self-unique district format, leaving that
        // search byte-identical to before.
        const res = await deps
          .searchByDocketNumber(ref.caseNumber, ref.courtId, token)
          .catch(() => null);
        if (res && res.count === 1 && res.results[0]) {
          parsed = { docketId: res.results[0].docket_id };
        } else if (res) {
          return {
            kind: "reply-suggest",
            caption: ref.caseNumber,
            matches: res.count,
          };
        }
      }
    }
  }
  // v1b: still no docket → Gemini proposes a {caption, courtId} hint from the
  // mention + thread prose, and ONE CL search verifies it. Provision only on an
  // exactly-one match — the confidence gate is the search-result shape, never
  // the model's own confidence (which can hallucinate a plausible caption).
  // Every failure (no hint, no quota, search error) degrades to the no-docket
  // reply: the requester is asked for a link, nothing is queued.
  if ("kind" in parsed && allowed && deps.inferCase && deps.searchDockets) {
    const hint = await deps
      .inferCase(m.text, collectThreadPosts(thread ?? undefined), m.links)
      .catch(() => null);
    if (hint) {
      const before = await loadLedger(deps.cfg.ledgerPath);
      const token = selectToken(
        before,
        deps.cfg.tokens,
        today(),
        1,
        Date.now(),
      );
      if (token) {
        // Charge the search call before issuing it, same crash-safe direction
        // as provisioning's reservation: a crash mid-search wastes 1 budgeted
        // call rather than leaving an unaccounted one. chargeAndRecord logs it to
        // the rolling window too, so the next selectToken sees this spend.
        await mutateLedger(deps.cfg.ledgerPath, (fresh) =>
          chargeAndRecord(fresh, 1, today(), token, Date.now()),
        );
        const res = await deps
          .searchDockets(hint.caption, hint.courtId ?? undefined, token)
          .catch(() => null);
        if (res) {
          // A Gemini caption is a guess, never a hard signal — even ONE match can
          // be a wrong same-name docket (a Joe-Biden news post resolved to the
          // terminated Hunter-Biden-IRS case). So the caption path NEVER
          // auto-provisions: count 0/1/≥2 all clarify with the requester. Hard
          // signals (a link, or a parsed docket NUMBER above) still provision.
          // On count===1 show what we actually FOUND (the matched caseName), not
          // the guess, so the confirm reply names the real candidate.
          const matched = res.count === 1 ? res.results[0] : undefined;
          console.log(
            `Caption inference: guess=${JSON.stringify(hint.caption)} courtId=${hint.courtId ?? "none"} count=${res.count} — degrading to clarify (no auto-provision from a name guess)`,
          );
          return {
            kind: "reply-suggest",
            caption: matched?.caseName ?? hint.caption,
            matches: res.count,
          };
        }
        // res === null (no result or search error) falls through to the
        // no-docket path below — the requester is asked for a link.
        console.log(
          `Caption inference: guess=${JSON.stringify(hint.caption)} courtId=${hint.courtId ?? "none"} count=search-failed — degrading to clarify (no auto-provision from a name guess)`,
        );
      }
    }
  }
  const ledger = await loadLedger(deps.cfg.ledgerPath);
  const existing =
    "docketId" in parsed ? findCase(ledger, parsed.docketId) : undefined;
  // Only a COMPLETED case dedupes to "already provisioned". A present-but-
  // incomplete entry is a crash zombie (handle doesn't resolve yet) — let it fall
  // through to enqueue so the drain re-runs runProvision, which RESUMES it.
  const completed = existing?.completed ? existing : undefined;
  const queuedJob =
    "docketId" in parsed ? findJob(queue, parsed.docketId) : undefined;
  // A re-mention is "already queued" when the existing job is still active —
  // queued OR backing off a retry. Keying on status === "queued" alone let a
  // re-mention of a retrying docket fall through to a redundant enqueue attempt.
  const alreadyQueued = queuedJob ? isActive(queuedJob) : false;
  const quotaOk =
    selectToken(
      ledger,
      deps.cfg.tokens,
      today(),
      MIN_QUOTA_FOR_CASE,
      Date.now(),
    ) !== undefined;
  const queueAhead = queue.jobs.filter((j) => j.status === "queued").length;
  return classify({
    allowed,
    parsed,
    existingHandle: completed?.handle,
    existingDid: completed?.did,
    alreadyQueued,
    quotaOk,
    queueAhead,
  });
}

// When the drain stalls on a budget/rate limit, tell EVERY waiting requester once
// — not just the head job. A single throttled or budget-exhausted poll means none
// of the active (queued/retrying) cases will shelve this cycle, so each acked
// requester gets one notice (`deferredNotified` dedupes across cycles) rather than
// silence behind the head. `kind` picks the honest timing: "deferred" (daily cap,
// resumes tomorrow) vs "throttled" (hourly window, reopens soon).
async function notifyAllDeferred(
  deps: BotDeps,
  queue: QueueState,
  kind: "deferred" | "throttled",
): Promise<QueueState> {
  let q = queue;
  for (const job of q.jobs) {
    if (!isActive(job)) continue;
    // Per-kind dedupe: a throttled ("soon") notice must not suppress a later
    // daily-deferred ("tomorrow") notice — they carry different, updated timing.
    const alreadyNotified =
      kind === "throttled" ? job.throttledNotified : job.deferredNotified;
    if (alreadyNotified) continue;
    q =
      kind === "throttled"
        ? markThrottledNotified(q, job.docketId)
        : markDeferredNotified(q, job.docketId);
    await persistQueue(deps.queuePath, q);
    await replyOrNewThread(
      deps,
      job.ackRef ?? job.mention,
      job.rootRef,
      { handle: job.requesterHandle, did: job.requesterDid },
      buildReply({ kind, docketId: job.docketId }),
    );
  }
  return q;
}

// When no token can start a case, decide what waiting requesters hear. Genuinely
// out of daily budget anywhere ⇒ "tomorrow". Otherwise every budgeted token is
// blocked by a cooldown OR the rolling-window prediction: if the soonest reopen is
// within the hour it's the 5/min or 50/hr window ("hang tight"); if it's further
// out it's CL's rolling 24h window outlasting our calendar-day counter, so still
// "tomorrow". The reopen time merges the reactive throttle cooldown (set after a
// 429) with the PREDICTIVE rolling-window time (rollingStartableAt), so the notice
// is honest even when we never fired a 429 — the whole point of the rolling log.
function classifyDeferral(
  ledger: Ledger,
  tokens: string[],
  day: string,
  nowMs: number,
): "deferred" | "throttled" {
  const budgeted = tokens.filter(
    (t) => quotaRemaining(ledger, day, t) >= MIN_QUOTA_FOR_CASE,
  );
  if (budgeted.length === 0) return "deferred";
  const soonestReopen = Math.min(
    ...budgeted.map((t) =>
      Math.max(
        throttledUntilMs(ledger, t, nowMs) ?? nowMs,
        rollingStartableAt(ledger, t, MIN_QUOTA_FOR_CASE, nowMs),
      ),
    ),
  );
  return soonestReopen - nowMs > THROTTLE_HOURLY_CEILING_MS
    ? "deferred"
    : "throttled";
}

async function drain(
  deps: BotDeps,
  provision: (id: number, cfg: ProvisionConfig) => Promise<ProvisionResult>,
): Promise<boolean> {
  let queue = await loadQueue(deps.queuePath);
  // Whether this drain shelved at least one case — drives a single directory
  // regeneration after the loop (not one per case).
  let provisioned = false;
  while (true) {
    const job = nextDrainable(queue, Date.now());
    if (!job) break;

    // Re-check the allowlist at drain time: the enqueue-time decision is cached
    // (soft TTL) and authoritative membership can change between ack and drain.
    // A requester revoked after their mention but before we provision is dropped
    // (terminal), not provisioned — burning ~17 CL calls on a now-unauthorized
    // request. No reply: a revoked user shouldn't get a provisioned-case link.
    if (!(await deps.allowlist.has(job.requesterDid))) {
      queue = markFailed(queue, job.docketId);
      await persistQueue(deps.queuePath, queue);
      continue;
    }

    // Re-read the ledger every iteration (asymmetric with the queue, loaded once
    // above): runProvision charges the shared CL quota under the lock as it runs,
    // so each job must see the freshly-spent count to honor the budget. The queue
    // is the bot's own single-writer in-memory authority, so re-reading it per
    // iteration would just re-load what we already hold.
    const ledger = await loadLedger(deps.cfg.ledgerPath);
    // No usable token → stop draining (the job stays queued and a later drain
    // resumes it). A token can be unusable for two reasons, with different timing:
    // genuinely out of daily budget (resumes tomorrow → "deferred") vs. in a
    // throttle cooldown. The cooldown check (nowMs) also means that once ONE case
    // throttles a token, the rest of the queue skips it here instead of each
    // re-discovering the throttle with a wasted 429. classifyDeferral keys the
    // requester notice off CL's reported reopen time, not our day-counter — which
    // can read "budget left" while CL's rolling window still has us locked.
    if (
      !selectToken(
        ledger,
        deps.cfg.tokens,
        today(),
        MIN_QUOTA_FOR_CASE,
        Date.now(),
      )
    ) {
      queue = await notifyAllDeferred(
        deps,
        queue,
        classifyDeferral(ledger, deps.cfg.tokens, today(), Date.now()),
      );
      break;
    }

    const parent = job.ackRef ?? job.mention;
    const result = await provision(job.docketId, deps.cfg);

    // On a transient error, decide retry-vs-fail BEFORE persisting so the
    // terminal/backoff marker is durable before any reply. retryCount is the
    // attempts already made; once it would exceed the cap we fail for good.
    const willRetry =
      result.status === "error" &&
      (job.retryCount ?? 0) + 1 <= MAX_PROVISION_RETRIES;

    // Persist the new state (and save) BEFORE posting the reply. A crash after a
    // completed provision but before this save would leave the job still
    // drainable, so on restart runProvision reruns, returns "exists", and fires
    // a duplicate reply. Marking first makes the reply at-most-once.
    if (result.status === "provisioned" || result.status === "exists") {
      queue = markDone(queue, job.docketId);
    } else if (result.status === "not-found") {
      queue = markFailed(queue, job.docketId);
    } else if (result.status === "error") {
      if (willRetry) {
        const nextRetry = (job.retryCount ?? 0) + 1;
        const nextAt = new Date(
          Date.now() + backoffMs(nextRetry),
        ).toISOString();
        queue = markRetrying(queue, job.docketId, nextAt);
      } else {
        queue = markFailed(queue, job.docketId);
      }
    } else if (result.status === "throttled") {
      // CourtListener's rate window closed mid-fetch. Not a fault: reschedule at
      // CL's reported reopening WITHOUT bumping retryCount (a closed window must
      // not count toward the failure cap), tell everyone waiting once, and stop
      // this cycle. A short cooldown is the 50/hr window (retries this poll loop);
      // a long one is the daily window (retries tomorrow) — honor whichever CL
      // reports instead of forcing an hourly retry against a daily lock.
      const untilMs =
        Date.now() + Math.min(result.retryAfterMs, MAX_THROTTLE_BACKOFF_MS);
      const until = new Date(untilMs).toISOString();
      queue = markThrottled(queue, job.docketId, until);
      // Cool down the WHOLE token (50/hr is per-token), so the rest of the queue
      // skips it at the gate above instead of each burning a 429 to rediscover it.
      await mutateLedger(deps.cfg.ledgerPath, (l) =>
        markTokenThrottled(l, result.token, until),
      );
      await persistQueue(deps.queuePath, queue);
      // "tomorrow" if CL handed us a daily-scale cooldown, else "hang tight".
      const kind =
        result.retryAfterMs > THROTTLE_HOURLY_CEILING_MS
          ? "deferred"
          : "throttled";
      queue = await notifyAllDeferred(deps, queue, kind);
      break;
    } else {
      // quota-exhausted mid-provision (a large docket's entry pagination outran
      // the reservation): leave the job queued — the next day's drain resumes it
      // automatically. Notify everyone waiting once that it'll finish tomorrow.
      queue = await notifyAllDeferred(deps, queue, "deferred");
      break;
    }
    await persistQueue(deps.queuePath, queue);

    if (result.status === "provisioned") {
      provisioned = true;
      const text = buildReply({
        kind: "provisioned",
        caseName: result.caseName,
        handle: result.handle,
        failed: result.failed,
      });
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
      await replyOrNewThread(
        deps,
        parent,
        job.rootRef,
        { handle: job.requesterHandle, did: job.requesterDid },
        text,
        replyFacets(text, deps, { handle: result.handle, did: result.did }),
        card,
      );
      // Also announce the new case from @ape's own feed (Feature B) — links the
      // case, never the requester. Best-effort inside announceProvision.
      await announceProvision(
        {
          agent: deps.agent,
          cardThumb: deps.cardThumb,
          announce: deps.announce,
        },
        result,
      );
    } else if (result.status === "exists") {
      const text = buildReply({ kind: "exists", handle: result.handle });
      const card = buildCaseCard(
        {
          handle: result.handle,
          caseName: result.caseName,
          docketNumber: result.docketNumber,
          courtName: result.courtName,
          filings: result.filings,
        },
        deps.cardThumb,
      );
      await replyOrNewThread(
        deps,
        parent,
        job.rootRef,
        { handle: job.requesterHandle, did: job.requesterDid },
        text,
        replyFacets(text, deps, { handle: result.handle, did: result.did }),
        card,
      );
    } else if (result.status === "not-found") {
      await replyOrNewThread(
        deps,
        parent,
        job.rootRef,
        { handle: job.requesterHandle, did: job.requesterDid },
        buildReply({ kind: "not-found" }),
      );
    } else if (result.status === "error" && willRetry) {
      // Transient error, backed off for another attempt — no reply yet. Log only
      // the docket id and status, never result.message: PDS auth errors can echo
      // credentials, and journald retains them indefinitely.
      console.error(
        `provision retrying for docket ${job.docketId} (attempt ${
          (job.retryCount ?? 0) + 1
        }/${MAX_PROVISION_RETRIES}): ${result.status}`,
      );
    } else {
      // Retries exhausted — post the apologetic failure reply so the requester
      // isn't left in permanent silence after the ack.
      console.error(
        `provision failed for docket ${job.docketId} after ${MAX_PROVISION_RETRIES} retries: ${result.status}`,
      );
      await replyOrNewThread(
        deps,
        parent,
        job.rootRef,
        { handle: job.requesterHandle, did: job.requesterDid },
        buildReply({ kind: "failed", docketId: job.docketId }),
      );
    }
  }
  return provisioned;
}

async function main(): Promise<void> {
  const env = (name: string): string => {
    const v = process.env[name];
    if (!v) throw new Error(`${name} not set`);
    return v;
  };
  const host = process.env.PDS_HOSTNAME;
  const agent = await createBotAgent({
    host,
    identifier: env("RCAPE_BOT_DID"),
    password: env("RCAPE_BOT_PASSWORD"),
  });
  const cfg: ProvisionConfig = {
    tokens: parseClTokens(),
    host,
    domain: process.env.RCAPE_HANDLE_DOMAIN ?? "rcape.org",
    hashN: Number(process.env.RCAPE_HASH_FIRST_N ?? "15"),
    adminPassword: env("PDS_ADMIN_PASSWORD"),
    cfToken: env("CLOUDFLARE_API_TOKEN"),
    zoneId: env("CLOUDFLARE_ZONE_ID"),
    ledgerPath: fileURLToPath(new URL("../data/ledger.json", import.meta.url)),
    cacheDir: fileURLToPath(new URL("../data/case-cache", import.meta.url)),
    // Public-directory gist (optional). The gist table needs BOTH a token and an
    // id; the graph.list runs regardless (bot self-auth only). The token is a
    // PropterMalone gist-scoped PAT; the id is the shelf gist created once under
    // PropterMalone. A malformed id is dropped here (warned) so the directory
    // skips the gist rather than PATCHing a bogus /gists/<garbage> path.
    gistToken: process.env.RCAPE_GIST_TOKEN,
    gistId: validGistId(process.env.RCAPE_DIRECTORY_GIST_ID),
  };
  const ownerHandle = env("RCAPE_OWNER_HANDLE");
  // Resolve the owner handle to a DID once at startup for the @proptermalone
  // mention facet. resolveHandle is an AppView read, not a CL call (no quota).
  const ownerDid = await resolveOwnerDid(
    agent.graph as unknown as Parameters<typeof resolveOwnerDid>[0],
    ownerHandle,
  );
  const allowlistTtlMs = Number(process.env.RCAPE_ALLOWLIST_TTL_MS ?? "60000");
  // v1b prose inference is armed only when a Gemini key is configured; absent,
  // the deps fields stay undefined and the bot behaves exactly as v1a.
  const geminiKey = process.env.RCAPE_GEMINI_API_KEY;
  const geminiModel = process.env.RCAPE_GEMINI_MODEL ?? "gemini-2.5-flash-lite";
  // Upload the seal once for the reply link-card thumbnail; reused across every
  // reply. Best-effort — a failure just yields text-only cards.
  let cardThumb: unknown;
  try {
    const sealPath = fileURLToPath(
      new URL("../assets/avatar.png", import.meta.url),
    );
    cardThumb = await agent.uploadBlob(await readFile(sealPath), "image/png");
    console.log("reply card thumbnail ready.");
  } catch (e) {
    console.warn(
      `card thumbnail unavailable: ${e instanceof Error ? e.message : e}`,
    );
  }
  // Watchlist sweeper armed only when a list URI is configured; absent, the bot is
  // by-request only. Tuning (threshold/interval/cap/floor) reads its own env in
  // watchlist.ts; here we just carry the list identifier that gates the feature.
  const watchlistUri = process.env.RCAPE_WATCHLIST_URI;
  // Pre-shelve harvest: a PRIVATE, comma-separated set of journalist accounts
  // (handles or DIDs) in RCAPE_HARVEST_ACCOUNTS, resolved to DIDs once at startup
  // (AppView, no CL quota). Never published anywhere — the source list stays in
  // .env. Empty/absent ⇒ the feature is off.
  const harvestAccounts: string[] = [];
  for (const raw of (process.env.RCAPE_HARVEST_ACCOUNTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (raw.startsWith("did:")) {
      harvestAccounts.push(raw);
      continue;
    }
    try {
      harvestAccounts.push(
        await resolveOwnerDid(
          agent.graph as unknown as Parameters<typeof resolveOwnerDid>[0],
          raw,
        ),
      );
    } catch (e) {
      console.warn(
        `harvest: could not resolve account "${raw}" — skipping: ${
          e instanceof Error ? e.message : e
        }`,
      );
    }
  }
  // Announce-on-provision is on by default; RCAPE_ANNOUNCE_PROVISIONS=0/false opts out.
  const announce = !/^(0|false|no)$/i.test(
    process.env.RCAPE_ANNOUNCE_PROVISIONS ?? "",
  );
  // Notify-thread carve-out: DIDs (Chris Geidner) whose threads get the one-time
  // shelve reply + the everything-else-routes-to-a-new-thread treatment. DIDs only
  // (no handle resolution): these must match the thread-root author DID at runtime.
  const notifyThreadDids = (process.env.RCAPE_NOTIFY_THREAD_ACCOUNTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("did:"));
  const deps: BotDeps = {
    agent,
    allowlist: new AllowlistCache(agent.graph, ownerDid, allowlistTtlMs),
    cfg,
    queuePath: fileURLToPath(new URL("../data/queue.json", import.meta.url)),
    preshelveQueuePath: fileURLToPath(
      new URL("../data/preshelve-queue.json", import.meta.url),
    ),
    ownerDid,
    cardThumb,
    announce,
    ...(watchlistUri ? { watchlist: { listUri: watchlistUri } } : {}),
    ...(harvestAccounts.length
      ? { harvest: { accounts: harvestAccounts } }
      : {}),
    ...(notifyThreadDids.length ? { notifyThreadDids } : {}),
    // Always wired (no Gemini needed): a fresh client per call (no throttle
    // interleaving with a concurrent provision client / no 13s pre-wait).
    searchByDocketNumber: async (caseNumber, courtId, token) => {
      try {
        return await new CourtListenerClient(token).searchByDocketNumber(
          caseNumber,
          courtId ?? undefined,
        );
      } catch (e) {
        console.error(
          "docket-number search failed:",
          e instanceof Error ? e.message : String(e),
        );
        return null;
      }
    },
    ...(geminiKey
      ? {
          inferCase: inferCaseFactory(new GeminiClient(geminiKey, geminiModel)),
          // A fresh client per search: fresh lastRequestAt (no 13s pre-wait)
          // and no throttle interleaving with a concurrent provision client.
          searchDockets: async (caption, courtId, token) => {
            try {
              return await new CourtListenerClient(token).searchDockets(
                caption,
                courtId,
              );
            } catch (e) {
              console.error(
                "case search failed:",
                e instanceof Error ? e.message : String(e),
              );
              return null;
            }
          },
        }
      : {}),
  };
  if (geminiKey) console.log(`prose case-inference armed (${geminiModel}).`);
  if (watchlistUri) {
    const wlThreshold = Number(process.env.RCAPE_WATCHLIST_THRESHOLD ?? 1);
    console.log(
      `watchlist sweeper armed (list ${watchlistUri}, threshold ${wlThreshold}).`,
    );
    if (wlThreshold <= 1) {
      console.warn(
        "watchlist: threshold=1 — any single list member linking a docket trips a provision; raise RCAPE_WATCHLIST_THRESHOLD to 2+ as the list grows.",
      );
    }
  }
  if (harvestAccounts.length) {
    console.log(
      `pre-shelve harvest armed (${harvestAccounts.length} private source account(s); drains near the daily reset with spare quota).`,
    );
  }
  if (!announce) console.log("announce-on-provision DISABLED.");
  if (notifyThreadDids.length) {
    console.log(
      `notify-thread carve-out armed for ${notifyThreadDids.length} account(s) (one-time shelve reply + thread-quarantine).`,
    );
  }

  const intervalMs = Number(process.env.RCAPE_POLL_INTERVAL_MS ?? "60000");
  console.log(`RC Ape bot up as ${agent.did}; polling every ${intervalMs}ms.`);
  for (;;) {
    try {
      await pollOnce(deps);
    } catch (e) {
      console.error("poll cycle failed:", e instanceof Error ? e.message : e);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
