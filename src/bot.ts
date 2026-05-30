// pattern: Imperative Shell
// The @-mention bot. Polls the bot account's notifications, classifies each
// mention, replies to everyone (ack on accept, decline/no-docket otherwise),
// enqueues provisionable requests, and drains the queue under the CL daily
// budget — posting the "done" reply with the new @handle. `classify` is a pure
// decision function (unit-tested); `pollOnce` is one testable cycle.

import { fileURLToPath } from "node:url";
import { AllowlistCache } from "./allowlist.js";
import { type BotAgent, createBotAgent } from "./botAgent.js";
import type { MentionNotif } from "./botAgent.js";
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
import { buildReply } from "./reply.js";

// A case is ~17 CL calls; require a little headroom before starting one.
const MIN_QUOTA_FOR_CASE = 20;
const PER_REQUESTER_CAP = 3;

export type Action =
  | { kind: "ack-enqueue"; docketId: number }
  | { kind: "ack-queued"; docketId: number; ahead: number }
  | { kind: "reply-exists"; handle: string }
  | { kind: "reply-declined" }
  | { kind: "reply-no-docket" }
  | { kind: "skip" };

export interface ClassifyInput {
  allowed: boolean;
  parsed: ReturnType<typeof parseMention>;
  existingHandle?: string;
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
    return { kind: "reply-exists", handle: input.existingHandle };
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
  provision?: (
    docketId: number,
    cfg: ProvisionConfig,
  ) => Promise<ProvisionResult>;
}

const today = (): string => new Date().toISOString().slice(0, 10);

export async function pollOnce(deps: BotDeps): Promise<void> {
  const provision = deps.provision ?? ((id, cfg) => runProvision(id, cfg));
  let queue = await loadQueue(deps.queuePath);
  const mentions = await deps.agent.listMentions();

  for (const m of mentions) {
    if (m.authorDid === deps.agent.did) continue; // never reply to self (loop guard)
    if (hasSeen(queue, m.uri)) continue;

    const action = await classifyMention(m, deps, queue);
    const parent: StrongRef = { uri: m.uri, cid: m.cid };

    if (action.kind === "reply-declined") {
      await deps.agent.reply(parent, m.root, buildReply({ kind: "declined" }));
    } else if (action.kind === "reply-no-docket") {
      await deps.agent.reply(parent, m.root, buildReply({ kind: "no-docket" }));
    } else if (action.kind === "reply-exists") {
      await deps.agent.reply(
        parent,
        m.root,
        buildReply({ kind: "exists", handle: action.handle }),
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
        const ackText =
          action.kind === "ack-enqueue"
            ? buildReply({ kind: "ack", docketId: action.docketId })
            : buildReply({
                kind: "queued",
                docketId: action.docketId,
                ahead: action.ahead,
              });
        const ackRef = await deps.agent.reply(parent, m.root, ackText);
        queue = setAck(queue, action.docketId, ackRef);
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
    const ledger = await loadLedger(deps.cfg.ledgerPath);
    if (quotaRemaining(ledger, today()) < MIN_QUOTA_FOR_CASE) break; // resume after reset

    const parent = job.ackRef ?? job.mention;
    const result = await provision(job.docketId, deps.cfg);
    if (result.status === "provisioned") {
      await deps.agent.reply(
        parent,
        job.rootRef,
        buildReply({
          kind: "provisioned",
          caseName: result.caseName,
          handle: result.handle,
        }),
      );
      queue = markDone(queue, job.docketId);
    } else if (result.status === "exists") {
      await deps.agent.reply(
        parent,
        job.rootRef,
        buildReply({ kind: "exists", handle: result.handle }),
      );
      queue = markDone(queue, job.docketId);
    } else if (result.status === "not-found") {
      await deps.agent.reply(
        parent,
        job.rootRef,
        buildReply({ kind: "not-found" }),
      );
      queue = markFailed(queue, job.docketId);
    } else if (result.status === "quota-exhausted") {
      break; // resume after reset
    } else {
      // error — leave a failed marker; don't spam a reply on transient errors.
      console.error(`provision failed for docket ${job.docketId}:`, result);
      queue = markFailed(queue, job.docketId);
    }
    await saveQueue(deps.queuePath, queue);
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
  const deps: BotDeps = {
    agent,
    allowlist: new AllowlistCache(agent.graph, env("RCAPE_OWNER_HANDLE")),
    cfg,
    queuePath: fileURLToPath(new URL("../data/queue.json", import.meta.url)),
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
