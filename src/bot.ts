// pattern: Imperative Shell
// The @-mention bot. Polls the bot account's notifications, classifies each
// mention, replies to everyone (ack on accept, decline/no-docket otherwise),
// enqueues provisionable requests, and drains the queue under the CL daily
// budget — posting the "done" reply with the new @handle. `classify` is a pure
// decision function (unit-tested); `pollOnce` is one testable cycle.

import { fileURLToPath } from "node:url";
import { AllowlistCache, resolveOwnerDid } from "./allowlist.js";
import { type BotAgent, createBotAgent } from "./botAgent.js";
import type { MentionNotif } from "./botAgent.js";
import type { CaseHint } from "./caseHint.js";
import { CourtListenerClient, parseClTokens } from "./courtlistener.js";
import type { ClSearchPage } from "./courtlistener.types.js";
import { type MentionFacet, mentionFacets } from "./facet.js";
import { GeminiClient, inferCaseFactory } from "./gemini.js";
import {
  chargeQuota,
  findCase,
  loadLedger,
  mutateLedger,
  selectToken,
} from "./ledger.js";
import { parseCaseRef, parseMention } from "./mention.js";
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

// Require this much free budget before STARTING a case, so one can't begin,
// exhaust a token's shared budget partway, and strand itself half-provisioned.
// MUST stay > RESERVED_CALLS_PER_CASE (provisionCase.ts = 10) so the gap absorbs
// the race between this check and runProvision's reservation charge. Drain
// re-checks before each job. Lowered 20→12 (2026-06-16) alongside the reservation:
// a typical case is ~3 REST calls (entries paginate at 100/page; doc hashing is
// off-quota), so the old 20 stranded ~a case worth of daily headroom; the
// graceful throttle handling backstops a rare bigger docket.
const MIN_QUOTA_FOR_CASE = 12;
// Cap on how far out a rate-throttled job is rescheduled. CourtListener reports
// the cooldown ("available in N seconds"); we honor it but clamp to 1h so a
// pathological value can't park a job indefinitely. The hourly window's real
// cooldown is well under this, so a throttled case retries near its reopening.
const MAX_THROTTLE_BACKOFF_MS = 3_600_000;
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

function backoffMs(retryCount: number): number {
  const i = Math.min(Math.max(0, retryCount - 1), RETRY_BACKOFF_MS.length - 1);
  return RETRY_BACKOFF_MS[i] ?? 60_000;
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

    // A plain reply (not an explicit @-mention) that yields nothing actionable —
    // declined or no-docket — gets SILENCE, not a nudge: a "thanks" reply to the
    // bot's "done" post must not draw "I admit only…" or "send me a link" noise.
    // Explicit @-mentions still reply to everyone. ("skip" already posts nothing.)
    const suppressNonActionable = m.source === "reply";

    if (action.kind === "reply-declined") {
      if (!suppressNonActionable) {
        const text = buildReply({ kind: "declined" });
        await deps.agent.reply(parent, m.root, text, replyFacets(text, deps));
      }
    } else if (action.kind === "reply-no-docket") {
      if (!suppressNonActionable) {
        await deps.agent.reply(
          parent,
          m.root,
          buildReply({ kind: "no-docket" }),
        );
      }
    } else if (action.kind === "reply-suggest") {
      await deps.agent.reply(
        parent,
        m.root,
        buildReply({
          kind: "suggest",
          caption: action.caption,
          matches: action.matches,
        }),
      );
    } else if (action.kind === "reply-exists") {
      const text = buildReply({ kind: "exists", handle: action.handle });
      await deps.agent.reply(
        parent,
        m.root,
        text,
        action.did
          ? replyFacets(text, deps, { handle: action.handle, did: action.did })
          : replyFacets(text, deps),
      );
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
        const ackRef = await deps.agent.reply(parent, m.root, ackText);
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
        await deps.agent.reply(
          parent,
          m.root,
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

  await drain(deps, provision);
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
      const token = selectToken(before, deps.cfg.tokens, today(), 1);
      if (token) {
        await mutateLedger(deps.cfg.ledgerPath, (fresh) =>
          chargeQuota(fresh, 1, today(), token),
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
      const token = selectToken(before, deps.cfg.tokens, today(), 1);
      if (token) {
        // Charge the search call before issuing it, same crash-safe direction
        // as provisioning's reservation: a crash mid-search wastes 1 budgeted
        // call rather than leaving an unaccounted one.
        await mutateLedger(deps.cfg.ledgerPath, (fresh) =>
          chargeQuota(fresh, 1, today(), token),
        );
        const res = await deps
          .searchDockets(hint.caption, hint.courtId ?? undefined, token)
          .catch(() => null);
        if (res && res.count === 1 && res.results[0]) {
          parsed = { docketId: res.results[0].docket_id };
        } else if (res) {
          return {
            kind: "reply-suggest",
            caption: hint.caption,
            matches: res.count,
          };
        }
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
    selectToken(ledger, deps.cfg.tokens, today(), MIN_QUOTA_FOR_CASE) !==
    undefined;
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
    await deps.agent.reply(
      job.ackRef ?? job.mention,
      job.rootRef,
      buildReply({ kind, docketId: job.docketId }),
    );
  }
  return q;
}

async function drain(
  deps: BotDeps,
  provision: (id: number, cfg: ProvisionConfig) => Promise<ProvisionResult>,
): Promise<void> {
  let queue = await loadQueue(deps.queuePath);
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
    // No token in the pool has room for a whole case → stop draining. The job
    // stays queued and the next day's drain (fresh budget) resumes it
    // automatically — no new request needed. Tell the requester once that their
    // acked case is paused until tomorrow (the flag dedupes across cycles).
    if (!selectToken(ledger, deps.cfg.tokens, today(), MIN_QUOTA_FOR_CASE)) {
      queue = await notifyAllDeferred(deps, queue, "deferred");
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
      // CourtListener's rate window closed mid-fetch. Not a fault: reschedule near
      // its reopening WITHOUT bumping retryCount (a closed window must not count
      // toward the failure cap), tell everyone waiting once, and stop this cycle.
      // The next 60s poll retries once the window is due to reopen.
      const nextAt = new Date(
        Date.now() + Math.min(result.retryAfterMs, MAX_THROTTLE_BACKOFF_MS),
      ).toISOString();
      queue = markThrottled(queue, job.docketId, nextAt);
      await persistQueue(deps.queuePath, queue);
      queue = await notifyAllDeferred(deps, queue, "throttled");
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
      const text = buildReply({
        kind: "provisioned",
        caseName: result.caseName,
        handle: result.handle,
        failed: result.failed,
      });
      await deps.agent.reply(
        parent,
        job.rootRef,
        text,
        replyFacets(text, deps, { handle: result.handle, did: result.did }),
      );
    } else if (result.status === "exists") {
      const text = buildReply({ kind: "exists", handle: result.handle });
      await deps.agent.reply(
        parent,
        job.rootRef,
        text,
        replyFacets(text, deps, { handle: result.handle, did: result.did }),
      );
    } else if (result.status === "not-found") {
      await deps.agent.reply(
        parent,
        job.rootRef,
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
      await deps.agent.reply(
        parent,
        job.rootRef,
        buildReply({ kind: "failed", docketId: job.docketId }),
      );
    }
  }
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
  const deps: BotDeps = {
    agent,
    allowlist: new AllowlistCache(agent.graph, ownerDid, allowlistTtlMs),
    cfg,
    queuePath: fileURLToPath(new URL("../data/queue.json", import.meta.url)),
    ownerDid,
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
