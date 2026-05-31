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
import { type MentionFacet, mentionFacets } from "./facet.js";
import { findCase, loadLedger, quotaRemaining } from "./ledger.js";
import { parseMention } from "./mention.js";
import {
  type ProvisionConfig,
  type ProvisionResult,
  runProvision,
} from "./provisionCase.js";
import {
  type Job,
  type StrongRef,
  enqueue,
  findJob,
  hasSeen,
  loadQueue,
  markDone,
  markFailed,
  markSeen,
  nextQueued,
  saveQueue,
  setAck,
} from "./queue.js";
import { OWNER_DISPLAY_HANDLE, buildReply } from "./reply.js";

// A case is ~17 CL calls; require a little headroom before starting one.
const MIN_QUOTA_FOR_CASE = 20;
const PER_REQUESTER_CAP = 3;

export type Action =
  | { kind: "ack-enqueue"; docketId: number }
  | { kind: "ack-queued"; docketId: number; ahead: number }
  | { kind: "reply-exists"; handle: string; did?: string }
  | { kind: "reply-declined" }
  | { kind: "reply-no-docket" }
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
}

const today = (): string => new Date().toISOString().slice(0, 10);

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
  // Paginate until we reach an already-processed notification, so a burst of
  // likes/follows can't scroll real mentions off page 1 and drop them.
  const mentions = await deps.agent.listMentions({
    isSeen: (uri) => hasSeen(queue, uri),
  });

  for (const m of mentions) {
    if (m.authorDid === deps.agent.did) continue; // never reply to self (loop guard)
    if (hasSeen(queue, m.uri)) continue;

    const action = await classifyMention(m, deps, queue);
    const parent: StrongRef = { uri: m.uri, cid: m.cid };

    if (action.kind === "reply-declined") {
      const text = buildReply({ kind: "declined" });
      await deps.agent.reply(parent, m.root, text, replyFacets(text, deps));
    } else if (action.kind === "reply-no-docket") {
      await deps.agent.reply(parent, m.root, buildReply({ kind: "no-docket" }));
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
        requesterHandle: m.authorHandle,
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
        await saveQueue(deps.queuePath, queue);

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
        await saveQueue(deps.queuePath, queue);
        continue;
      }
      // enqueue rejected (duplicate / over cap) → no reply, just mark seen.
    }

    queue = markSeen(queue, m.uri);
    await saveQueue(deps.queuePath, queue);
  }

  await drain(deps, provision);
}

async function classifyMention(
  m: MentionNotif,
  deps: BotDeps,
  queue: Awaited<ReturnType<typeof loadQueue>>,
): Promise<Action> {
  const parsed = parseMention(m.text);
  const allowed = await deps.allowlist.has(m.authorDid);
  const ledger = await loadLedger(deps.cfg.ledgerPath);
  const existing =
    "docketId" in parsed ? findCase(ledger, parsed.docketId) : undefined;
  const queuedJob =
    "docketId" in parsed ? findJob(queue, parsed.docketId) : undefined;
  const alreadyQueued = queuedJob?.status === "queued";
  const quotaOk = quotaRemaining(ledger, today()) >= MIN_QUOTA_FOR_CASE;
  const queueAhead = queue.jobs.filter((j) => j.status === "queued").length;
  return classify({
    allowed,
    parsed,
    existingHandle: existing?.handle,
    existingDid: existing?.did,
    alreadyQueued,
    quotaOk,
    queueAhead,
  });
}

async function drain(
  deps: BotDeps,
  provision: (id: number, cfg: ProvisionConfig) => Promise<ProvisionResult>,
): Promise<void> {
  let queue = await loadQueue(deps.queuePath);
  while (true) {
    const job = nextQueued(queue);
    if (!job) break;

    // Re-check the allowlist at drain time: the enqueue-time decision is cached
    // (soft TTL) and authoritative membership can change between ack and drain.
    // A requester revoked after their mention but before we provision is dropped
    // (terminal), not provisioned — burning ~17 CL calls on a now-unauthorized
    // request. No reply: a revoked user shouldn't get a provisioned-case link.
    if (!(await deps.allowlist.has(job.requesterDid))) {
      queue = markFailed(queue, job.docketId);
      await saveQueue(deps.queuePath, queue);
      continue;
    }

    const ledger = await loadLedger(deps.cfg.ledgerPath);
    if (quotaRemaining(ledger, today()) < MIN_QUOTA_FOR_CASE) break; // resume after reset

    const parent = job.ackRef ?? job.mention;
    const result = await provision(job.docketId, deps.cfg);

    // Persist the terminal state (and save) BEFORE posting the reply. A crash
    // after a completed provision but before this save would leave the job still
    // queued, so on restart runProvision reruns, returns "exists", and fires a
    // duplicate reply. Marking the job terminal first makes the reply at-most-once.
    if (result.status === "provisioned" || result.status === "exists") {
      queue = markDone(queue, job.docketId);
    } else if (result.status === "not-found" || result.status === "error") {
      queue = markFailed(queue, job.docketId);
    } else {
      // quota-exhausted: leave the job queued and resume after the daily reset.
      break;
    }
    await saveQueue(deps.queuePath, queue);

    if (result.status === "provisioned") {
      const text = buildReply({
        kind: "provisioned",
        caseName: result.caseName,
        handle: result.handle,
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
    } else {
      // error — failed marker already persisted; don't spam a reply on transient
      // errors. Log only the docket id and status, never result.message: PDS auth
      // errors can echo credentials, and journald retains them indefinitely.
      console.error(
        `provision failed for docket ${job.docketId}: ${result.status}`,
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
    token: env("COURTLISTENER_API_TOKEN"),
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
  const deps: BotDeps = {
    agent,
    allowlist: new AllowlistCache(agent.graph, ownerHandle, allowlistTtlMs),
    cfg,
    queuePath: fileURLToPath(new URL("../data/queue.json", import.meta.url)),
    ownerDid,
  };

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
