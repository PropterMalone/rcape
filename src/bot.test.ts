import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AllowlistCache, type GraphClient } from "./allowlist.js";
import { type BotDeps, classify, parseNotifyThreadDids } from "./bot.js";
import type { BotAgent, MentionNotif } from "./botAgent.js";
import {
  chargeQuota,
  emptyLedger,
  loadLedger,
  quotaRemaining,
  recordCalls,
  recordCase,
  saveLedger,
} from "./ledger.js";
import type { ProvisionConfig, ProvisionResult } from "./provisionCase.js";
import {
  type Job,
  type StrongRef,
  findJob,
  loadQueue,
  saveQueue,
} from "./queue.js";
import type { ThreadView } from "./thread.js";

describe("classify", () => {
  const docket = { docketId: 69777799 } as const;
  const base = {
    parsed: docket,
    alreadyQueued: false,
    quotaOk: true,
    queueAhead: 0,
  };

  it("declines a non-allowlisted requester even with a valid docket", () => {
    expect(classify({ ...base, allowed: false })).toEqual({
      kind: "reply-declined",
    });
  });

  it("asks for a docket when none parsed", () => {
    expect(
      classify({ ...base, allowed: true, parsed: { kind: "no-docket" } }),
    ).toEqual({ kind: "reply-no-docket" });
  });

  it("replies with the existing handle when already provisioned", () => {
    expect(
      classify({ ...base, allowed: true, existingHandle: "x.rcape.org" }),
    ).toEqual({ kind: "reply-exists", handle: "x.rcape.org" });
  });

  it("skips a docket already queued", () => {
    expect(classify({ ...base, allowed: true, alreadyQueued: true })).toEqual({
      kind: "skip",
    });
  });

  it("prefers reply-exists over skip when both provisioned AND queued", () => {
    // A docket can be both already provisioned (in the ledger) and have a stale
    // queued job; the existing handle is the useful answer, so exists wins.
    expect(
      classify({
        ...base,
        allowed: true,
        existingHandle: "y.rcape.org",
        existingDid: "did:y",
        alreadyQueued: true,
      }),
    ).toEqual({ kind: "reply-exists", handle: "y.rcape.org", did: "did:y" });
  });

  it("acks + enqueues a fresh request with quota available", () => {
    expect(classify({ ...base, allowed: true })).toEqual({
      kind: "ack-enqueue",
      docketId: 69777799,
    });
  });

  it("queues behind the budget when quota is exhausted", () => {
    expect(
      classify({ ...base, allowed: true, quotaOk: false, queueAhead: 4 }),
    ).toEqual({ kind: "ack-queued", docketId: 69777799, ahead: 4 });
  });
});

function allowGraph(dids: string[]): GraphClient {
  const allowed = new Set(dids);
  return {
    app: {
      bsky: {
        graph: {
          getRelationships: vi.fn(async ({ others }) => ({
            data: {
              relationships: others.map((did: string) => ({
                did,
                ...(allowed.has(did) ? { followedBy: "at://x" } : {}),
              })),
            },
          })),
        },
      },
    },
  };
}

function mockAgent(mentions: MentionNotif[], thread: ThreadView | null = null) {
  const replies: {
    parent: StrongRef;
    text: string;
    facets?: import("./facet.js").MentionFacet[];
    embed?: unknown;
  }[] = [];
  const seenAts: string[] = [];
  // Standalone posts created via createRecord (e.g. the new-thread re-routes).
  const posts: { collection: string; record: unknown }[] = [];
  // In-memory own-repo records for the directory feature (no-ops in tests that
  // don't set a gist id, but typed so the mock satisfies BotAgent).
  const records = new Map<string, unknown>();
  const agent: BotAgent = {
    did: "did:bot",
    graph: allowGraph(["did:alice"]),
    listMentions: async () => mentions,
    reply: async (parent, _root, text, facets, embed) => {
      replies.push({ parent, text, facets, embed });
      return { uri: `reply-${replies.length}`, cid: `c${replies.length}` };
    },
    uploadBlob: async () => ({ $type: "blob", ref: "seal" }),
    updateSeen: async (seenAt) => {
      seenAts.push(seenAt);
    },
    getPostThread: async () => thread,
    getListFeed: async () => ({ items: [] }),
    getAuthorFeed: async () => ({ items: [] }),
    createRecord: async (collection, record) => {
      posts.push({ collection, record });
      return { uri: `at://did:bot/${collection}/auto`, cid: "c" };
    },
    putRecord: async (collection, rkey, record) => {
      records.set(`${collection}/${rkey}`, record);
      return { uri: `at://did:bot/${collection}/${rkey}`, cid: "c" };
    },
    getRecord: async (collection, rkey) => records.get(`${collection}/${rkey}`),
    listRecords: async () => [],
    deleteRecord: async (collection, rkey) => {
      records.delete(`${collection}/${rkey}`);
    },
  };
  return { agent, replies, seenAts, posts };
}

const provisionStub = async (): Promise<ProvisionResult> => ({
  status: "provisioned",
  handle: "abrego-garcia.rcape.org",
  did: "did:case",
  caseName: "Abrego Garcia v. Noem",
  published: 265,
  failed: 0,
});

// A single allowlisted mention that parses to a docket — used to drive a full
// enqueue+drain cycle with a stubbed provision result.
function aliceMention(): MentionNotif {
  return {
    uri: "m-alice",
    cid: "ca",
    authorDid: "did:alice",
    authorHandle: "alice.test",
    text: "@ape.rcape.org add https://www.courtlistener.com/docket/69777799/x/",
    root: { uri: "m-alice", cid: "ca" },
  };
}

describe("drain error logging (no credential leak)", () => {
  it("never logs the raw provision result or a credential-bearing message", async () => {
    const { pollOnce } = await import("./bot.js");
    const dir = await mkdtemp(join(tmpdir(), "rcape-bot-"));
    const errs: unknown[][] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        errs.push(args);
      });
    try {
      const ledgerPath = join(dir, "ledger.json");
      const queuePath = join(dir, "queue.json");
      await saveLedger(ledgerPath, emptyLedger());
      const { agent } = mockAgent([aliceMention()]);
      const cfg = {
        tokens: ["t"],
        domain: "rcape.org",
        hashN: 0,
        adminPassword: "",
        cfToken: "",
        zoneId: "",
        ledgerPath,
      } as ProvisionConfig;
      const deps: BotDeps = {
        agent,
        allowlist: new AllowlistCache(agent.graph, "owner.test"),
        cfg,
        queuePath,
        // Error whose message carries a sentinel credential string.
        provision: async (): Promise<ProvisionResult> => ({
          status: "error",
          message: "PDS auth failed PASSWORD=xyz while minting",
        }),
      };

      await pollOnce(deps);

      const logged = errs.map((a) => JSON.stringify(a)).join("\n");
      expect(logged).not.toContain("PASSWORD=xyz");
      expect(logged).not.toContain("xyz");
      // The docket id is still logged so the failure is diagnosable.
      expect(logged).toContain("69777799");
    } finally {
      spy.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("crash-zombie is resumed, not reported as already provisioned", () => {
  it("enqueues + drains a present-but-incomplete ledger entry instead of replying exists", async () => {
    const { pollOnce } = await import("./bot.js");
    const dir = await mkdtemp(join(tmpdir(), "rcape-bot-"));
    try {
      const ledgerPath = join(dir, "ledger.json");
      const queuePath = join(dir, "queue.json");
      // A zombie: credentials persisted early, no `completed` flag — the handle
      // doesn't resolve yet, so the bot must NOT tell the requester it's done.
      await saveLedger(
        ledgerPath,
        recordCase(emptyLedger(), 69777799, {
          did: "did:plc:zombie",
          handle: "zombie.rcape.org",
          password: "pw",
          createdAt: "2026-05-30",
        }),
      );
      const { agent, replies } = mockAgent([aliceMention()]);
      let provisionCalls = 0;
      const cfg = {
        tokens: ["t"],
        domain: "rcape.org",
        hashN: 0,
        adminPassword: "",
        cfToken: "",
        zoneId: "",
        ledgerPath,
      } as ProvisionConfig;
      const deps: BotDeps = {
        agent,
        allowlist: new AllowlistCache(agent.graph, "owner.test"),
        cfg,
        queuePath,
        provision: async (): Promise<ProvisionResult> => {
          provisionCalls++;
          return provisionStub();
        },
      };

      await pollOnce(deps);

      // The zombie was RESUMED through the provision path (old code returned
      // `exists` and never enqueued, so provision was never called).
      expect(provisionCalls).toBe(1);
      // No reply pointed the requester at the unresolved zombie handle.
      expect(replies.some((r) => r.text.includes("zombie.rcape.org"))).toBe(
        false,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("persist-before-reply (no duplicate provision on crash)", () => {
  it("marks the job terminal before the done-reply, so a crash mid-reply does not re-provision", async () => {
    const { pollOnce } = await import("./bot.js");
    const dir = await mkdtemp(join(tmpdir(), "rcape-bot-"));
    try {
      const ledgerPath = join(dir, "ledger.json");
      const queuePath = join(dir, "queue.json");
      await saveLedger(ledgerPath, emptyLedger());

      const { agent } = mockAgent([aliceMention()]);
      let provisionCalls = 0;
      let doneReplies = 0;
      // Fail the FIRST done-reply (simulate a crash after persist, before reply).
      let failNextDoneReply = true;
      const origReply = agent.reply;
      agent.reply = async (parent, root, text) => {
        if (text.includes("@abrego-garcia.rcape.org")) {
          doneReplies++;
          if (failNextDoneReply) {
            failNextDoneReply = false;
            throw new Error("simulated crash mid-reply");
          }
        }
        return origReply(parent, root, text);
      };
      const cfg = {
        tokens: ["t"],
        domain: "rcape.org",
        hashN: 0,
        adminPassword: "",
        cfToken: "",
        zoneId: "",
        ledgerPath,
      } as ProvisionConfig;
      const deps: BotDeps = {
        agent,
        allowlist: new AllowlistCache(agent.graph, "owner.test"),
        cfg,
        queuePath,
        provision: async (): Promise<ProvisionResult> => {
          provisionCalls++;
          return provisionStub();
        },
      };

      // First cycle: enqueue + ack + drain, but the done-reply throws.
      await expect(pollOnce(deps)).rejects.toThrow("simulated crash mid-reply");
      // The job was persisted terminal BEFORE the failing reply.
      const q1 = await loadQueue(queuePath);
      expect(q1.jobs[0]?.status).toBe("done");
      expect(provisionCalls).toBe(1);

      // Restart: the mention is already seen and the job is terminal, so the
      // bot neither re-provisions nor fires a duplicate done-reply.
      await pollOnce(deps);
      expect(provisionCalls).toBe(1);
      // Only the single (failed) done-reply attempt was ever made.
      expect(doneReplies).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("pollOnce", () => {
  it("skips self, acks + provisions an allowlisted request, and dedupes", async () => {
    const { pollOnce } = await import("./bot.js");
    const dir = await mkdtemp(join(tmpdir(), "rcape-bot-"));
    try {
      const ledgerPath = join(dir, "ledger.json");
      const queuePath = join(dir, "queue.json");
      await saveLedger(ledgerPath, emptyLedger());

      const mentions: MentionNotif[] = [
        {
          uri: "m-self",
          cid: "cs",
          authorDid: "did:bot",
          authorHandle: "ape.rcape.org",
          text: "@ape.rcape.org talking to myself",
          root: { uri: "m-self", cid: "cs" },
        },
        {
          uri: "m-alice",
          cid: "ca",
          authorDid: "did:alice",
          authorHandle: "alice.test",
          text: "@ape.rcape.org add https://www.courtlistener.com/docket/69777799/x/",
          root: { uri: "m-alice", cid: "ca" },
        },
      ];
      const { agent, replies } = mockAgent(mentions);
      const cfg = {
        tokens: ["t"],
        domain: "rcape.org",
        hashN: 0,
        adminPassword: "",
        cfToken: "",
        zoneId: "",
        ledgerPath,
      } as ProvisionConfig;
      const deps: BotDeps = {
        agent,
        allowlist: new AllowlistCache(agent.graph, "owner.test"),
        cfg,
        queuePath,
        provision: provisionStub,
      };

      await pollOnce(deps);

      // self mention produced no reply; alice got ack then done.
      expect(replies).toHaveLength(2);
      expect(replies[0]?.text).toContain("69777799"); // ack
      expect(replies[1]?.text).toContain("@abrego-garcia.rcape.org"); // done
      // The done reply carries a mention facet for the new case account, so the
      // provisioned account is notified and the @handle links.
      const doneFacet = replies[1]?.facets?.[0];
      expect(doneFacet?.features[0]?.did).toBe("did:case");
      expect(doneFacet?.features[0]?.$type).toBe(
        "app.bsky.richtext.facet#mention",
      );
      // The done reply also carries a link card to the case profile (thumb is
      // wired separately via deps.cardThumb, unset in this test → text card).
      const card = replies[1]?.embed as {
        $type: string;
        external: { uri: string; title: string; thumb?: unknown };
      };
      expect(card?.$type).toBe("app.bsky.embed.external");
      expect(card?.external.uri).toBe(
        "https://bsky.app/profile/abrego-garcia.rcape.org",
      );
      expect(card?.external.title).toBe("Abrego Garcia v. Noem");
      // ack reply (replies[0]) gets no card.
      expect(replies[0]?.embed).toBeUndefined();
      const q1 = await loadQueue(queuePath);
      expect(q1.jobs[0]?.status).toBe("done");
      expect(q1.seen.has("m-alice")).toBe(true);

      // second cycle: alice's mention is already seen → no new replies.
      await pollOnce(deps);
      expect(replies).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("over-cap requester", () => {
  it("replies (not silence) when a requester at their cap mentions another docket", async () => {
    const { pollOnce } = await import("./bot.js");
    const dir = await mkdtemp(join(tmpdir(), "rcape-bot-"));
    try {
      const ledgerPath = join(dir, "ledger.json");
      const queuePath = join(dir, "queue.json");
      await saveLedger(ledgerPath, emptyLedger());

      // Pre-seed alice at the PER_REQUESTER_CAP (3) with distinct dockets so a
      // new mention is rejected with `requester-cap`, not `duplicate`.
      const queued = (docketId: number): Job => ({
        docketId,
        requesterDid: "did:alice",
        requesterHandle: "alice.test",
        mention: { uri: `m${docketId}`, cid: `c${docketId}` },
        rootRef: { uri: `m${docketId}`, cid: `c${docketId}` },
        status: "queued",
        createdAt: "2026-05-31T00:00:00.000Z",
      });
      await saveQueue(queuePath, {
        jobs: [queued(11111111), queued(22222222), queued(33333333)],
        seen: new Set(),
      });

      // alice mentions a fourth, distinct docket → over her cap.
      const fourth: MentionNotif = {
        uri: "m-alice-4",
        cid: "ca4",
        authorDid: "did:alice",
        authorHandle: "alice.test",
        text: "@ape.rcape.org add https://www.courtlistener.com/docket/44444444/x/",
        root: { uri: "m-alice-4", cid: "ca4" },
      };
      const { agent, replies } = mockAgent([fourth]);
      const deps: BotDeps = {
        agent,
        allowlist: new AllowlistCache(agent.graph, "owner.test"),
        cfg: baseCfg(ledgerPath),
        queuePath,
        // Never provision: quota check is skipped here; we only test the reply.
        provision: async (): Promise<ProvisionResult> => provisionStub(),
      };

      await pollOnce(deps);

      // The over-cap mention got a reply — not silent — and the mention is seen.
      const overCap = replies.find((r) => r.text.includes("already"));
      expect(overCap).toBeDefined();
      expect(overCap?.text).toContain("3"); // surfaces the in-flight count
      const q = await loadQueue(queuePath);
      expect(q.seen.has("m-alice-4")).toBe(true);
      // No new job was enqueued for the fourth docket.
      expect(findJob(q, 44444444)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("drain-time allowlist re-check", () => {
  it("drops a job whose requester was revoked after enqueue (no provision)", async () => {
    const { pollOnce } = await import("./bot.js");
    const dir = await mkdtemp(join(tmpdir(), "rcape-bot-"));
    try {
      const ledgerPath = join(dir, "ledger.json");
      const queuePath = join(dir, "queue.json");
      await saveLedger(ledgerPath, emptyLedger());

      // A mutable allowlist source: alice is allowed at enqueue, then revoked
      // before drain re-checks. ttl=0 forces a re-resolve on every has().
      let allowed = ["did:alice"];
      const graph: GraphClient = {
        app: {
          bsky: {
            graph: {
              getRelationships: vi.fn(async ({ others }) => ({
                data: {
                  relationships: others.map((did: string) => ({
                    did,
                    ...(allowed.includes(did) ? { followedBy: "at://x" } : {}),
                  })),
                },
              })),
            },
          },
        },
      };
      const { agent, replies } = mockAgent([aliceMention()]);
      agent.graph = graph;
      // Revoke alice the moment classify has acked her (the first has() at
      // enqueue sees her; the drain re-check below must not).
      const revokeAfterEnqueue = new AllowlistCache(graph, "owner.test", 0);
      const origHas = revokeAfterEnqueue.has.bind(revokeAfterEnqueue);
      let calls = 0;
      revokeAfterEnqueue.has = async (did: string) => {
        const r = await origHas(did);
        calls++;
        if (calls === 1) allowed = []; // revoke right after the enqueue check
        return r;
      };

      let provisionCalls = 0;
      const cfg = {
        tokens: ["t"],
        domain: "rcape.org",
        hashN: 0,
        adminPassword: "",
        cfToken: "",
        zoneId: "",
        ledgerPath,
      } as ProvisionConfig;
      const deps: BotDeps = {
        agent,
        allowlist: revokeAfterEnqueue,
        cfg,
        queuePath,
        provision: async () => {
          provisionCalls++;
          return provisionStub();
        },
      };

      await pollOnce(deps);

      // Acked at enqueue, then revoked → drain must NOT provision.
      expect(provisionCalls).toBe(0);
      // Only the ack reply went out; no done/provisioned reply.
      expect(replies.some((r) => r.text.includes("@abrego-garcia"))).toBe(
        false,
      );
      // The job is in a terminal state, not left queued.
      const q = await loadQueue(queuePath);
      expect(q.jobs[0]?.status).not.toBe("queued");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function baseCfg(ledgerPath: string): ProvisionConfig {
  return {
    tokens: ["t"],
    domain: "rcape.org",
    hashN: 0,
    adminPassword: "",
    cfToken: "",
    zoneId: "",
    ledgerPath,
  } as ProvisionConfig;
}

describe("transient-failure retry with backoff", () => {
  it("backs off a transient error and re-drains on a later cycle (not abandoned)", async () => {
    vi.useFakeTimers();
    const { pollOnce } = await import("./bot.js");
    const dir = await mkdtemp(join(tmpdir(), "rcape-bot-"));
    try {
      const ledgerPath = join(dir, "ledger.json");
      const queuePath = join(dir, "queue.json");
      await saveLedger(ledgerPath, emptyLedger());
      const { agent, replies } = mockAgent([aliceMention()]);

      let attempts = 0;
      const deps: BotDeps = {
        agent,
        allowlist: new AllowlistCache(agent.graph, "owner.test"),
        cfg: baseCfg(ledgerPath),
        queuePath,
        // Fail the first attempt transiently, succeed on the retry.
        provision: async (): Promise<ProvisionResult> => {
          attempts++;
          return attempts === 1
            ? { status: "error", message: "transient PDS blip" }
            : provisionStub();
        },
      };

      // Cycle 1: ack + a transient error → job set to retrying, no failure reply.
      await pollOnce(deps);
      expect(attempts).toBe(1);
      let q = await loadQueue(queuePath);
      expect(q.jobs[0]?.status).toBe("retrying");
      expect(q.jobs[0]?.retryCount).toBe(1);
      expect(replies.some((r) => r.text.includes("@abrego-garcia"))).toBe(
        false,
      );

      // A poll before the backoff elapses must NOT re-attempt.
      await pollOnce(deps);
      expect(attempts).toBe(1);

      // After the backoff window, the retry runs and succeeds.
      vi.advanceTimersByTime(61_000);
      await pollOnce(deps);
      expect(attempts).toBe(2);
      q = await loadQueue(queuePath);
      expect(q.jobs[0]?.status).toBe("done");
      expect(replies.some((r) => r.text.includes("@abrego-garcia"))).toBe(true);
    } finally {
      vi.useRealTimers();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("posts an apologetic failure reply once retries are exhausted", async () => {
    vi.useFakeTimers();
    const { pollOnce } = await import("./bot.js");
    const dir = await mkdtemp(join(tmpdir(), "rcape-bot-"));
    try {
      const ledgerPath = join(dir, "ledger.json");
      const queuePath = join(dir, "queue.json");
      await saveLedger(ledgerPath, emptyLedger());
      const { agent, replies } = mockAgent([aliceMention()]);

      let attempts = 0;
      const deps: BotDeps = {
        agent,
        allowlist: new AllowlistCache(agent.graph, "owner.test"),
        cfg: baseCfg(ledgerPath),
        queuePath,
        provision: async (): Promise<ProvisionResult> => {
          attempts++;
          return { status: "error", message: "always fails" };
        },
      };

      // Drive enough cycles past each backoff to exhaust the retries.
      await pollOnce(deps); // attempt 1 → retrying
      for (let i = 0; i < 5; i++) {
        vi.advanceTimersByTime(60 * 60_000); // jump past the longest backoff
        await pollOnce(deps);
      }

      const q = await loadQueue(queuePath);
      expect(q.jobs[0]?.status).toBe("failed");
      // 1 initial + 3 retries = 4 provision attempts before failing for good.
      expect(attempts).toBe(4);
      // The requester gets exactly one apologetic failure reply.
      const failReplies = replies.filter((r) =>
        r.text.includes("couldn't shelve"),
      );
      expect(failReplies).toHaveLength(1);
      expect(failReplies[0]?.text).toContain("69777799");
    } finally {
      vi.useRealTimers();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a future-dated retrying job does not starve a ready job behind it", async () => {
    vi.useFakeTimers();
    const { pollOnce } = await import("./bot.js");
    const dir = await mkdtemp(join(tmpdir(), "rcape-bot-"));
    try {
      const ledgerPath = join(dir, "ledger.json");
      const queuePath = join(dir, "queue.json");
      await saveLedger(ledgerPath, emptyLedger());

      // Two allowlisted requesters: bob's docket always fails (→ retrying), and
      // carol's docket (mentioned after) must still drain.
      const bob: MentionNotif = {
        uri: "m-bob",
        cid: "cb",
        authorDid: "did:bob",
        authorHandle: "bob.test",
        text: "@ape.rcape.org add https://www.courtlistener.com/docket/11111111/x/",
        root: { uri: "m-bob", cid: "cb" },
      };
      const carol: MentionNotif = {
        uri: "m-carol",
        cid: "cc",
        authorDid: "did:carol",
        authorHandle: "carol.test",
        text: "@ape.rcape.org add https://www.courtlistener.com/docket/22222222/x/",
        root: { uri: "m-carol", cid: "cc" },
      };
      const { agent, replies } = mockAgent([bob, carol]);
      agent.graph = allowGraph(["did:bob", "did:carol"]);

      const provisioned: number[] = [];
      const deps: BotDeps = {
        agent,
        allowlist: new AllowlistCache(agent.graph, "owner.test", 0),
        cfg: baseCfg(ledgerPath),
        queuePath,
        provision: async (docketId): Promise<ProvisionResult> => {
          if (docketId === 11111111) {
            return { status: "error", message: "bob's docket flaps" };
          }
          provisioned.push(docketId);
          return provisionStub();
        },
      };

      await pollOnce(deps);

      // bob's job is backing off (retrying), but carol's job still got drained —
      // the stuck job did not head-of-line block the queue.
      expect(provisioned).toContain(22222222);
      const q = await loadQueue(queuePath);
      expect(findJob(q, 11111111)?.status).toBe("retrying");
      expect(findJob(q, 22222222)?.status).toBe("done");
      expect(replies.some((r) => r.text.includes("@abrego-garcia"))).toBe(true);
    } finally {
      vi.useRealTimers();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("drain branches", () => {
  it("a not-found result fails the job and posts no done/provisioned reply", async () => {
    const { pollOnce } = await import("./bot.js");
    const dir = await mkdtemp(join(tmpdir(), "rcape-bot-"));
    try {
      const ledgerPath = join(dir, "ledger.json");
      const queuePath = join(dir, "queue.json");
      await saveLedger(ledgerPath, emptyLedger());
      const { agent, replies } = mockAgent([aliceMention()]);
      const deps: BotDeps = {
        agent,
        allowlist: new AllowlistCache(agent.graph, "owner.test"),
        cfg: baseCfg(ledgerPath),
        queuePath,
        provision: async (): Promise<ProvisionResult> => ({
          status: "not-found",
        }),
      };

      await pollOnce(deps);

      const q = await loadQueue(queuePath);
      expect(q.jobs[0]?.status).toBe("failed");
      // No done/provisioned reply; a not-found reply was posted instead.
      expect(replies.some((r) => r.text.includes("@abrego-garcia"))).toBe(
        false,
      );
      expect(replies.some((r) => r.text.includes("No such docket"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a quota-exhausted result stops drain and leaves the job queued for the next cycle", async () => {
    const { pollOnce } = await import("./bot.js");
    const dir = await mkdtemp(join(tmpdir(), "rcape-bot-"));
    try {
      const ledgerPath = join(dir, "ledger.json");
      const queuePath = join(dir, "queue.json");
      await saveLedger(ledgerPath, emptyLedger());
      const { agent, replies } = mockAgent([aliceMention()]);

      let attempts = 0;
      const deps: BotDeps = {
        agent,
        allowlist: new AllowlistCache(agent.graph, "owner.test"),
        cfg: baseCfg(ledgerPath),
        queuePath,
        provision: async (): Promise<ProvisionResult> => {
          attempts++;
          // First drain hits the budget; the second (next cycle) succeeds.
          return attempts === 1
            ? { status: "quota-exhausted", day: "2026-05-31" }
            : provisionStub();
        },
      };

      await pollOnce(deps);

      // Drain stopped on quota-exhausted: the job is still queued (not failed),
      // and no done/provisioned reply went out.
      let q = await loadQueue(queuePath);
      expect(q.jobs[0]?.status).toBe("queued");
      expect(replies.some((r) => r.text.includes("@abrego-garcia"))).toBe(
        false,
      );

      // Next cycle (budget restored): the still-queued job drains and completes.
      await pollOnce(deps);
      q = await loadQueue(queuePath);
      expect(q.jobs[0]?.status).toBe("done");
      expect(replies.some((r) => r.text.includes("@abrego-garcia"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("rate-limit throttling", () => {
  const aliceDocketB = (): MentionNotif => ({
    uri: "m-alice-b",
    cid: "cb",
    authorDid: "did:alice",
    authorHandle: "alice.test",
    text: "@ape.rcape.org add https://www.courtlistener.com/docket/71795960/y/",
    root: { uri: "m-alice-b", cid: "cb" },
  });

  it("after one case throttles the token, the next cycle skips the rest at the gate (no per-case 429 burn)", async () => {
    vi.useFakeTimers();
    const { pollOnce } = await import("./bot.js");
    const dir = await mkdtemp(join(tmpdir(), "rcape-bot-"));
    try {
      const ledgerPath = join(dir, "ledger.json");
      const queuePath = join(dir, "queue.json");
      await saveLedger(ledgerPath, emptyLedger()); // full daily budget
      const { agent, replies } = mockAgent([aliceMention(), aliceDocketB()]);
      let attempts = 0;
      const deps: BotDeps = {
        agent,
        allowlist: new AllowlistCache(agent.graph, "owner.test"),
        cfg: baseCfg(ledgerPath),
        queuePath,
        provision: async (): Promise<ProvisionResult> => {
          attempts++;
          return { status: "throttled", retryAfterMs: 60_000, token: "t" };
        },
      };

      // Cycle 1: job A is attempted, throttles, and cools down token "t" pool-wide.
      await pollOnce(deps);
      expect(attempts).toBe(1);
      // The token was cooled down pool-wide (persisted in the ledger).
      const cooled = (await loadLedger(ledgerPath)).throttledUntil ?? {};
      expect(Object.values(cooled)).toHaveLength(1);

      // Cycle 2 (5s later, before the 60s cooldown): job B is drainable, but the
      // gate sees the token cooling down and STOPS — without the fix, B would burn
      // a second 429. attempts must stay 1.
      vi.advanceTimersByTime(5_000);
      await pollOnce(deps);
      expect(attempts).toBe(1);
      // Daily budget is full, so the pause is reported as a throttle, not "tomorrow".
      expect(replies.some((r) => r.text.includes("finish it tomorrow"))).toBe(
        false,
      );
    } finally {
      vi.useRealTimers();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stops the drain BEFORE a 429 when the rolling 24h window is full (calendar counter still fresh)", async () => {
    const { pollOnce } = await import("./bot.js");
    const dir = await mkdtemp(join(tmpdir(), "rcape-bot-"));
    try {
      const ledgerPath = join(dir, "ledger.json");
      const queuePath = join(dir, "queue.json");
      // The exact 2026-06-16 post-reset state: the calendar counter reads fresh
      // (emptyLedger → 125 free) while CL's rolling 24h window still holds 120
      // calls made 12h ago. Without the rolling log the bot drains into a 429.
      const now = Date.now();
      const seeded = recordCalls(emptyLedger(), "t", now - 12 * 3_600_000, 120);
      await saveLedger(ledgerPath, seeded);
      const { agent, replies } = mockAgent([aliceMention()]);
      let attempts = 0;
      const deps: BotDeps = {
        agent,
        allowlist: new AllowlistCache(agent.graph, "owner.test"),
        cfg: baseCfg(ledgerPath),
        queuePath,
        provision: async (): Promise<ProvisionResult> => {
          attempts++;
          return provisionStub();
        },
      };

      await pollOnce(deps);

      // The predictive gate stopped the drain — provision was NEVER called, so no
      // CL request was issued and no 429 was eaten.
      expect(attempts).toBe(0);
      const q = await loadQueue(queuePath);
      expect(q.jobs[0]?.status).toBe("queued"); // resumes a later cycle
      // The 24h window reopens ~12h out, well past the hourly ceiling → "tomorrow".
      expect(replies.some((r) => r.text.includes("finish it tomorrow"))).toBe(
        true,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports 'hang tight' (not 'tomorrow') when the 50/hr window blocks the start", async () => {
    const { pollOnce } = await import("./bot.js");
    const dir = await mkdtemp(join(tmpdir(), "rcape-bot-"));
    try {
      const ledgerPath = join(dir, "ledger.json");
      const queuePath = join(dir, "queue.json");
      // 50 calls this hour → the 51st would 429 on the 50/hr scope (a 2026-06-16
      // freeze cause). The hour window reopens ~1h out — inside the hourly ceiling,
      // so classifyDeferral must say "hang tight", not "tomorrow". The calendar
      // counter is fresh (emptyLedger), so ONLY the 50/hr window blocks here.
      const seeded = recordCalls(emptyLedger(), "t", Date.now(), 50);
      await saveLedger(ledgerPath, seeded);
      const { agent, replies } = mockAgent([aliceMention()]);
      let attempts = 0;
      const deps: BotDeps = {
        agent,
        allowlist: new AllowlistCache(agent.graph, "owner.test"),
        cfg: baseCfg(ledgerPath),
        queuePath,
        provision: async (): Promise<ProvisionResult> => {
          attempts++;
          return provisionStub();
        },
      };

      await pollOnce(deps);

      expect(attempts).toBe(0); // predicted at the gate, never fired → no 429
      expect(
        replies.some((r) => r.text.toLowerCase().includes("hang tight")),
      ).toBe(true);
      expect(replies.some((r) => r.text.includes("finish it tomorrow"))).toBe(
        false,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports 'hang tight' (not 'tomorrow') when only the 5/min window blocks the start", async () => {
    const { pollOnce } = await import("./bot.js");
    const dir = await mkdtemp(join(tmpdir(), "rcape-bot-"));
    try {
      const ledgerPath = join(dir, "ledger.json");
      const queuePath = join(dir, "queue.json");
      // 5 calls this minute → the next call would 429 ("5/min"), but the minute
      // window reopens in <60s. classifyDeferral must say "hang tight", not "tomorrow".
      const seeded = recordCalls(emptyLedger(), "t", Date.now(), 5);
      await saveLedger(ledgerPath, seeded);
      const { agent, replies } = mockAgent([aliceMention()]);
      let attempts = 0;
      const deps: BotDeps = {
        agent,
        allowlist: new AllowlistCache(agent.graph, "owner.test"),
        cfg: baseCfg(ledgerPath),
        queuePath,
        provision: async (): Promise<ProvisionResult> => {
          attempts++;
          return provisionStub();
        },
      };

      await pollOnce(deps);

      expect(attempts).toBe(0); // predicted, never fired
      expect(
        replies.some((r) => r.text.toLowerCase().includes("hang tight")),
      ).toBe(true);
      expect(replies.some((r) => r.text.includes("finish it tomorrow"))).toBe(
        false,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a throttled provision stops drain, reschedules without a fault, and notifies EVERY waiting requester", async () => {
    const { pollOnce } = await import("./bot.js");
    const dir = await mkdtemp(join(tmpdir(), "rcape-bot-"));
    try {
      const ledgerPath = join(dir, "ledger.json");
      const queuePath = join(dir, "queue.json");
      await saveLedger(ledgerPath, emptyLedger());
      const { agent, replies } = mockAgent([aliceMention(), aliceDocketB()]);

      let attempts = 0;
      const deps: BotDeps = {
        agent,
        allowlist: new AllowlistCache(agent.graph, "owner.test"),
        cfg: baseCfg(ledgerPath),
        queuePath,
        provision: async (): Promise<ProvisionResult> => {
          attempts++;
          return { status: "throttled", retryAfterMs: 5_000, token: "t" };
        },
      };

      await pollOnce(deps);

      // Drain stopped on the first throttled provision — the second job was never
      // attempted (no head-of-line crawl through the rate window).
      expect(attempts).toBe(1);

      const q = await loadQueue(queuePath);
      const jobA = q.jobs.find((j) => j.docketId === 69777799);
      const jobB = q.jobs.find((j) => j.docketId === 71795960);
      // The throttled job is rescheduled (retrying + future nextAttemptAt) but its
      // retryCount is untouched — a closed window is not a fault.
      expect(jobA?.status).toBe("retrying");
      expect(jobA?.retryCount).toBeUndefined();
      expect(Date.parse(jobA?.nextAttemptAt ?? "")).toBeGreaterThan(Date.now());
      // The job behind it stays queued — but is told, not left silent.
      expect(jobB?.status).toBe("queued");

      // EVERY waiting requester gets exactly one "rate limit / hang tight" notice,
      // honest about timing (not the daily "tomorrow"), and nobody gets a failure.
      const rateReplies = replies.filter((r) =>
        r.text.toLowerCase().includes("rate limit"),
      );
      expect(rateReplies).toHaveLength(2);
      expect(rateReplies.some((r) => r.text.includes("69777799"))).toBe(true);
      expect(rateReplies.some((r) => r.text.includes("71795960"))).toBe(true);
      expect(rateReplies.some((r) => r.text.includes("tomorrow"))).toBe(false);
      expect(replies.some((r) => r.text.includes("couldn't shelve"))).toBe(
        false,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a daily-scale throttle (long retry-after) tells requesters TOMORROW and honors CL's full cooldown, not a 1h cap", async () => {
    const { pollOnce } = await import("./bot.js");
    const dir = await mkdtemp(join(tmpdir(), "rcape-bot-"));
    try {
      const ledgerPath = join(dir, "ledger.json");
      const queuePath = join(dir, "queue.json");
      await saveLedger(ledgerPath, emptyLedger());
      const { agent, replies } = mockAgent([aliceMention()]);

      // CourtListener's rolling daily window is closed: it reports a ~10h cooldown
      // even though our day-counter still shows budget. The bot must believe CL.
      const tenHoursMs = 10 * 60 * 60 * 1000;
      const deps: BotDeps = {
        agent,
        allowlist: new AllowlistCache(agent.graph, "owner.test"),
        cfg: baseCfg(ledgerPath),
        queuePath,
        provision: async (): Promise<ProvisionResult> => ({
          status: "throttled",
          retryAfterMs: tenHoursMs,
          token: "t",
        }),
      };

      await pollOnce(deps);

      // Requester hears "tomorrow", NOT the hourly "hang tight" — a 10h lock is the
      // daily window, classified off CL's reported cooldown not our day-counter.
      expect(replies.some((r) => r.text.includes("finish it tomorrow"))).toBe(
        true,
      );
      expect(
        replies.some((r) => r.text.toLowerCase().includes("hang tight")),
      ).toBe(false);

      // The token cooldown reflects CL's real ~10h reopen, not a capped 1h — so the
      // bot sleeps until the window actually reopens instead of banging hourly.
      const cooled = (await loadLedger(ledgerPath)).throttledUntil ?? {};
      const untilMs = Date.parse(Object.values(cooled)[0] ?? "");
      expect(untilMs - Date.now()).toBeGreaterThan(2 * 60 * 60 * 1000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a throttle notice does NOT suppress a later daily-deferred notice (separate flags)", async () => {
    vi.useFakeTimers();
    const { pollOnce } = await import("./bot.js");
    const dir = await mkdtemp(join(tmpdir(), "rcape-bot-"));
    try {
      const ledgerPath = join(dir, "ledger.json");
      const queuePath = join(dir, "queue.json");
      const day = new Date().toISOString().slice(0, 10);
      await saveLedger(ledgerPath, emptyLedger());
      const { agent, replies } = mockAgent([aliceMention()]);
      const deps: BotDeps = {
        agent,
        allowlist: new AllowlistCache(agent.graph, "owner.test"),
        cfg: baseCfg(ledgerPath),
        queuePath,
        provision: async (): Promise<ProvisionResult> => ({
          status: "throttled",
          retryAfterMs: 5_000,
          token: "t",
        }),
      };

      // Cycle 1 (budget free): hourly throttle → "hang tight".
      await pollOnce(deps);
      expect(
        replies.some((r) => r.text.toLowerCase().includes("rate limit")),
      ).toBe(true);
      expect(replies.some((r) => r.text.includes("finish it tomorrow"))).toBe(
        false,
      );

      // Now the daily cap is hit and the throttle backoff elapses.
      await saveLedger(ledgerPath, chargeQuota(emptyLedger(), 120, day, "t"));
      vi.advanceTimersByTime(6_000);

      // Cycle 2: the budget gate fires → the "tomorrow" notice MUST still post,
      // even though the throttle notice already did (the bug: one shared flag).
      await pollOnce(deps);
      const tomorrow = replies.filter((r) =>
        r.text.includes("finish it tomorrow"),
      );
      expect(tomorrow).toHaveLength(1);
      expect(tomorrow[0]?.text).toContain("69777799");
    } finally {
      vi.useRealTimers();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a throttled job retries on a later cycle and completes — no retry-count cost", async () => {
    vi.useFakeTimers();
    const { pollOnce } = await import("./bot.js");
    const dir = await mkdtemp(join(tmpdir(), "rcape-bot-"));
    try {
      const ledgerPath = join(dir, "ledger.json");
      const queuePath = join(dir, "queue.json");
      await saveLedger(ledgerPath, emptyLedger());
      const { agent, replies } = mockAgent([aliceMention()]);

      let attempts = 0;
      const deps: BotDeps = {
        agent,
        allowlist: new AllowlistCache(agent.graph, "owner.test"),
        cfg: baseCfg(ledgerPath),
        queuePath,
        provision: async (): Promise<ProvisionResult> => {
          attempts++;
          // Throttled first; the window reopens and the retry succeeds.
          return attempts === 1
            ? { status: "throttled", retryAfterMs: 5_000, token: "t" }
            : provisionStub();
        },
      };

      await pollOnce(deps); // throttled → retrying
      let q = await loadQueue(queuePath);
      expect(q.jobs[0]?.status).toBe("retrying");
      expect(q.jobs[0]?.retryCount).toBeUndefined();

      // A poll before the rescheduled time must not re-attempt.
      await pollOnce(deps);
      expect(attempts).toBe(1);

      // After the window reopens, the retry runs and completes.
      vi.advanceTimersByTime(6_000);
      await pollOnce(deps);
      expect(attempts).toBe(2);
      q = await loadQueue(queuePath);
      expect(q.jobs[0]?.status).toBe("done");
      expect(q.jobs[0]?.retryCount).toBeUndefined(); // never counted as a failure
      expect(replies.some((r) => r.text.includes("@abrego-garcia"))).toBe(true);
    } finally {
      vi.useRealTimers();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("thread-scan (v1a)", () => {
  // The mention names no docket; the post it replies to links one. The bot must
  // resolve it from the thread and provision exactly as if the link were pasted.
  const noDocketMention = (): MentionNotif => ({
    uri: "m-alice",
    cid: "ca",
    authorDid: "did:alice",
    authorHandle: "alice.test",
    text: "@ape.rcape.org can you add this one?",
    root: { uri: "m-root", cid: "cr" },
  });
  const linkFacet = (uri: string) => ({
    features: [{ $type: "app.bsky.richtext.facet#link", uri }],
  });

  it("provisions a docket linked only in an ancestor post", async () => {
    const { pollOnce } = await import("./bot.js");
    const dir = await mkdtemp(join(tmpdir(), "rcape-bot-"));
    try {
      const ledgerPath = join(dir, "ledger.json");
      const queuePath = join(dir, "queue.json");
      await saveLedger(ledgerPath, emptyLedger());

      const thread: ThreadView = {
        post: { record: { text: noDocketMention().text } },
        parent: {
          post: {
            record: {
              text: "this just got filed",
              facets: [
                linkFacet("https://www.courtlistener.com/docket/69777799/x/"),
              ],
            },
          },
        },
      };
      const { agent, replies } = mockAgent([noDocketMention()], thread);
      const deps: BotDeps = {
        agent,
        allowlist: new AllowlistCache(agent.graph, "owner.test"),
        cfg: baseCfg(ledgerPath),
        queuePath,
        provision: provisionStub,
      };

      await pollOnce(deps);

      // Thread-derived docket drove a full ack + provision (ack carries the id,
      // done carries the new @handle) — identical to a pasted-link mention.
      expect(replies).toHaveLength(2);
      expect(replies[0]?.text).toContain("69777799");
      expect(replies[1]?.text).toContain("@abrego-garcia.rcape.org");
      const q = await loadQueue(queuePath);
      expect(q.jobs[0]?.docketId).toBe(69777799);
      expect(q.jobs[0]?.status).toBe("done");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("replies no-docket (no enqueue) when neither mention nor thread links a docket", async () => {
    const { pollOnce } = await import("./bot.js");
    const dir = await mkdtemp(join(tmpdir(), "rcape-bot-"));
    try {
      const ledgerPath = join(dir, "ledger.json");
      const queuePath = join(dir, "queue.json");
      await saveLedger(ledgerPath, emptyLedger());

      const thread: ThreadView = {
        post: { record: { text: noDocketMention().text } },
        parent: { post: { record: { text: "just vibes, no docket" } } },
      };
      const { agent, replies } = mockAgent([noDocketMention()], thread);
      const deps: BotDeps = {
        agent,
        allowlist: new AllowlistCache(agent.graph, "owner.test"),
        cfg: baseCfg(ledgerPath),
        queuePath,
        provision: provisionStub,
      };

      await pollOnce(deps);

      // Exactly one reply (no-docket), nothing enqueued.
      expect(replies).toHaveLength(1);
      expect((await loadQueue(queuePath)).jobs).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // Fix A: a plain reply to one of the bot's own posts (no re-typed @handle) is
  // now processed — but a contentless one ("thanks") must draw silence, not a
  // decline/no-docket nudge, while a docket link handed back must provision.
  it("stays silent on a contentless reply to the bot (no nudge, no enqueue)", async () => {
    const { pollOnce } = await import("./bot.js");
    const dir = await mkdtemp(join(tmpdir(), "rcape-bot-"));
    try {
      const ledgerPath = join(dir, "ledger.json");
      const queuePath = join(dir, "queue.json");
      await saveLedger(ledgerPath, emptyLedger());
      const replyMention: MentionNotif = {
        uri: "r-alice",
        cid: "cr",
        authorDid: "did:alice",
        authorHandle: "alice.test",
        text: "thanks!",
        root: { uri: "m-root", cid: "cr" },
        source: "reply",
      };
      const { agent, replies } = mockAgent([replyMention], null);
      const deps: BotDeps = {
        agent,
        allowlist: new AllowlistCache(agent.graph, "owner.test"),
        cfg: baseCfg(ledgerPath),
        queuePath,
        provision: provisionStub,
      };

      await pollOnce(deps);

      expect(replies).toHaveLength(0);
      expect((await loadQueue(queuePath)).jobs).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does NOT re-post the case link on a reply that resolves to an already-shelved case", async () => {
    const { pollOnce } = await import("./bot.js");
    const dir = await mkdtemp(join(tmpdir(), "rcape-bot-"));
    try {
      const ledgerPath = join(dir, "ledger.json");
      const queuePath = join(dir, "queue.json");
      // Docket 69777799 already shelved (the bot posted its link in this thread).
      await saveLedger(
        ledgerPath,
        recordCase(emptyLedger(), 69777799, {
          did: "did:case",
          handle: "abrego.rcape.org",
          password: "pw",
          createdAt: "2026-05-30",
          completed: true,
        }),
      );
      // A "thank you" reply that still carries the docket link → resolves to the
      // existing case. On a reply, the link must NOT be re-posted.
      const replyMention: MentionNotif = {
        uri: "r-alice",
        cid: "cr",
        authorDid: "did:alice",
        authorHandle: "alice.test",
        text: "thank you! https://www.courtlistener.com/docket/69777799/x/",
        links: ["https://www.courtlistener.com/docket/69777799/x/"],
        root: { uri: "m-root", cid: "cr" },
        source: "reply",
      };
      const { agent, replies } = mockAgent([replyMention], null);
      const deps: BotDeps = {
        agent,
        allowlist: new AllowlistCache(agent.graph, "owner.test"),
        cfg: baseCfg(ledgerPath),
        queuePath,
        provision: provisionStub,
      };

      await pollOnce(deps);

      expect(replies).toHaveLength(0); // no redundant re-link
      // But an explicit @-mention of the same existing case still replies.
      const mention: MentionNotif = {
        ...replyMention,
        uri: "m-alice",
        text: "@ape.rcape.org https://www.courtlistener.com/docket/69777799/x/",
        source: "mention",
      };
      const { agent: agent2, replies: replies2 } = mockAgent([mention], null);
      await pollOnce({
        agent: agent2,
        allowlist: new AllowlistCache(agent2.graph, "owner.test"),
        cfg: baseCfg(ledgerPath),
        queuePath: join(dir, "queue2.json"),
        provision: provisionStub,
      });
      expect(replies2.some((r) => r.text.includes("@abrego.rcape.org"))).toBe(
        true,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("acks the owner's launch announcement with a bare 'Ook.' (no docket nudge)", async () => {
    const { pollOnce } = await import("./bot.js");
    const dir = await mkdtemp(join(tmpdir(), "rcape-bot-"));
    try {
      const ledgerPath = join(dir, "ledger.json");
      const queuePath = join(dir, "queue.json");
      await saveLedger(ledgerPath, emptyLedger());
      const announce: MentionNotif = {
        uri: "m-announce",
        cid: "ca",
        authorDid: "did:owner",
        authorHandle: "proptermalone.bsky.social",
        text: "Announcing R.C. Ape (@ape.rcape.org): an atproto librarian for federal court dockets.",
        root: { uri: "m-announce", cid: "ca" },
        source: "mention",
      };
      const { agent, replies } = mockAgent([announce], null);
      const deps: BotDeps = {
        agent,
        allowlist: new AllowlistCache(agent.graph, "owner.test"),
        cfg: baseCfg(ledgerPath),
        queuePath,
        ownerDid: "did:owner",
        provision: provisionStub,
      };

      await pollOnce(deps);

      expect(replies).toHaveLength(1);
      expect(replies[0]?.text).toBe("Ook.");
      expect((await loadQueue(queuePath)).jobs).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does NOT fire the announcement ack for a non-owner posting the same text", async () => {
    const { pollOnce } = await import("./bot.js");
    const dir = await mkdtemp(join(tmpdir(), "rcape-bot-"));
    try {
      const ledgerPath = join(dir, "ledger.json");
      const queuePath = join(dir, "queue.json");
      await saveLedger(ledgerPath, emptyLedger());
      const impostor: MentionNotif = {
        uri: "m-imp",
        cid: "ci",
        authorDid: "did:alice",
        authorHandle: "alice.test",
        text: "Announcing R.C. Ape — look at this cool bot @ape.rcape.org",
        root: { uri: "m-imp", cid: "ci" },
        source: "mention",
      };
      const { agent, replies } = mockAgent([impostor], null);
      const deps: BotDeps = {
        agent,
        allowlist: new AllowlistCache(agent.graph, "owner.test"),
        cfg: baseCfg(ledgerPath),
        queuePath,
        ownerDid: "did:owner",
        provision: provisionStub,
      };

      await pollOnce(deps);

      // alice is allowlisted but not the owner → normal no-docket path, not "Ook."
      expect(replies[0]?.text).not.toBe("Ook.");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("defers a quota-exhausted case once with a 'finish tomorrow' reply, leaving it queued to auto-resume", async () => {
    const { pollOnce } = await import("./bot.js");
    const dir = await mkdtemp(join(tmpdir(), "rcape-bot-"));
    try {
      const ledgerPath = join(dir, "ledger.json");
      const queuePath = join(dir, "queue.json");
      await saveLedger(ledgerPath, emptyLedger());
      const { agent, replies } = mockAgent([aliceMention()]);
      const deps: BotDeps = {
        agent,
        allowlist: new AllowlistCache(agent.graph, "owner.test"),
        cfg: baseCfg(ledgerPath),
        queuePath,
        // Simulate a large docket outrunning its reservation mid-provision.
        provision: async (): Promise<ProvisionResult> => ({
          status: "quota-exhausted",
          day: new Date().toISOString().slice(0, 10),
        }),
      };

      await pollOnce(deps); // ack-enqueue + drain → quota-exhausted → deferred
      const isDeferred = (t: string) => t.includes("finish it tomorrow");
      expect(replies.filter((r) => isDeferred(r.text))).toHaveLength(1);
      const q1 = await loadQueue(queuePath);
      expect(q1.jobs[0]?.status).toBe("queued"); // NOT failed — auto-resumes
      expect(q1.jobs[0]?.deferredNotified).toBe(true);

      await pollOnce(deps); // next cycle: still deferred, but no duplicate notice
      expect(replies.filter((r) => isDeferred(r.text))).toHaveLength(1);
      expect((await loadQueue(queuePath)).jobs[0]?.status).toBe("queued");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("starts a case at 13 calls of headroom (lowered gate) instead of stranding it", async () => {
    const { pollOnce } = await import("./bot.js");
    const dir = await mkdtemp(join(tmpdir(), "rcape-bot-"));
    try {
      const ledgerPath = join(dir, "ledger.json");
      const queuePath = join(dir, "queue.json");
      const day = new Date().toISOString().slice(0, 10);
      // 112/125 spent → 13 free. Under the old gate (20) this deferred; the
      // lowered gate (12) lets the case start, recovering the daily tail.
      await saveLedger(ledgerPath, chargeQuota(emptyLedger(), 112, day, "t"));
      const { agent, replies } = mockAgent([aliceMention()]);
      let provisioned = 0;
      const deps: BotDeps = {
        agent,
        allowlist: new AllowlistCache(agent.graph, "owner.test"),
        cfg: baseCfg(ledgerPath),
        queuePath,
        provision: async (): Promise<ProvisionResult> => {
          provisioned++;
          return provisionStub();
        },
      };

      await pollOnce(deps);

      expect(provisioned).toBe(1); // gate passed at 13 free
      expect((await loadQueue(queuePath)).jobs[0]?.status).toBe("done");
      expect(replies.some((r) => r.text.includes("@abrego-garcia"))).toBe(true);
      expect(replies.some((r) => r.text.includes("finish it tomorrow"))).toBe(
        false,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("provisions when a docket link is handed back as a reply to the bot", async () => {
    const { pollOnce } = await import("./bot.js");
    const dir = await mkdtemp(join(tmpdir(), "rcape-bot-"));
    try {
      const ledgerPath = join(dir, "ledger.json");
      const queuePath = join(dir, "queue.json");
      await saveLedger(ledgerPath, emptyLedger());
      const replyWithLink: MentionNotif = {
        uri: "r-alice",
        cid: "cr",
        authorDid: "did:alice",
        authorHandle: "alice.test",
        // Bluesky-truncated text; the full URL rides in links (Karl's exact case).
        text: "www.courtlistener.com/docket/73482...",
        links: [
          "https://www.courtlistener.com/docket/73482575/kahn-v-anthropic-pbc/",
        ],
        root: { uri: "m-root", cid: "cr" },
        source: "reply",
      };
      const { agent, replies } = mockAgent([replyWithLink], null);
      const deps: BotDeps = {
        agent,
        allowlist: new AllowlistCache(agent.graph, "owner.test"),
        cfg: baseCfg(ledgerPath),
        queuePath,
        provision: provisionStub,
      };

      await pollOnce(deps);

      // ack (carries the docket id) + provisioned (carries the @handle).
      expect(replies).toHaveLength(2);
      expect(replies[0]?.text).toContain("73482575");
      expect((await loadQueue(queuePath)).jobs[0]?.docketId).toBe(73482575);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("v1b inference is NOT consulted when the thread already links a docket", async () => {
    const { pollOnce } = await import("./bot.js");
    const dir = await mkdtemp(join(tmpdir(), "rcape-bot-"));
    try {
      const ledgerPath = join(dir, "ledger.json");
      const queuePath = join(dir, "queue.json");
      await saveLedger(ledgerPath, emptyLedger());

      const thread: ThreadView = {
        post: { record: { text: noDocketMention().text } },
        parent: {
          post: {
            record: {
              text: "filed today",
              facets: [
                linkFacet("https://www.courtlistener.com/docket/69777799/x/"),
              ],
            },
          },
        },
      };
      const { agent } = mockAgent([noDocketMention()], thread);
      const inferCase = vi.fn(async () => null);
      const deps: BotDeps = {
        agent,
        allowlist: new AllowlistCache(agent.graph, "owner.test"),
        cfg: baseCfg(ledgerPath),
        queuePath,
        provision: provisionStub,
        inferCase,
        searchDockets: vi.fn(async () => null),
      };

      await pollOnce(deps);

      expect(inferCase).not.toHaveBeenCalled();
      expect((await loadQueue(queuePath)).jobs[0]?.docketId).toBe(69777799);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not throw when the thread fetch fails (best-effort)", async () => {
    const { pollOnce } = await import("./bot.js");
    const dir = await mkdtemp(join(tmpdir(), "rcape-bot-"));
    try {
      const ledgerPath = join(dir, "ledger.json");
      const queuePath = join(dir, "queue.json");
      await saveLedger(ledgerPath, emptyLedger());

      const { agent, replies } = mockAgent([noDocketMention()]);
      agent.getPostThread = async () => {
        throw new Error("getPostThread network failure");
      };
      const deps: BotDeps = {
        agent,
        allowlist: new AllowlistCache(agent.graph, "owner.test"),
        cfg: baseCfg(ledgerPath),
        queuePath,
        provision: provisionStub,
      };

      // A failed thread read falls through to the no-docket reply, never aborts.
      await expect(pollOnce(deps)).resolves.toBeUndefined();
      expect(replies).toHaveLength(1);
      expect((await loadQueue(queuePath)).jobs).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("prose inference (v1b)", () => {
  const proseMention = (): MentionNotif => ({
    uri: "m-alice",
    cid: "ca",
    authorDid: "did:alice",
    authorHandle: "alice.test",
    text: "@ape.rcape.org can you shelve the Abrego Garcia case?",
    root: { uri: "m-root", cid: "cr" },
  });
  const proseThread = (): ThreadView => ({
    post: { record: { text: proseMention().text } },
    parent: {
      post: { record: { text: "huge ruling out of Maryland today" } },
    },
  });
  const hint = { caption: "Abrego Garcia v. Noem", courtId: "mdd" };
  const oneMatch = {
    count: 1,
    results: [
      {
        docket_id: 69777799,
        caseName: "Abrego Garcia v. Noem",
        court_id: "mdd",
        docketNumber: "8:25-cv-00951",
        dateFiled: "2025-03-24",
      },
    ],
  };
  const todayStr = new Date().toISOString().slice(0, 10);

  // Shared scaffolding: temp ledger+queue, mock agent over the prose thread,
  // injectable inference/search seams.
  async function run(opts: {
    inferCase?: BotDeps["inferCase"];
    searchDockets?: BotDeps["searchDockets"];
    searchByDocketNumber?: BotDeps["searchByDocketNumber"];
    mention?: MentionNotif;
    thread?: ThreadView | null;
    prepLedger?: (
      l: ReturnType<typeof emptyLedger>,
    ) => ReturnType<typeof emptyLedger>;
  }) {
    const { pollOnce } = await import("./bot.js");
    const dir = await mkdtemp(join(tmpdir(), "rcape-bot-"));
    const ledgerPath = join(dir, "ledger.json");
    const queuePath = join(dir, "queue.json");
    const prep = opts.prepLedger ?? ((l) => l);
    await saveLedger(ledgerPath, prep(emptyLedger()));
    const { agent, replies } = mockAgent(
      [opts.mention ?? proseMention()],
      opts.thread === undefined ? proseThread() : opts.thread,
    );
    const deps: BotDeps = {
      agent,
      allowlist: new AllowlistCache(agent.graph, "owner.test"),
      cfg: baseCfg(ledgerPath),
      queuePath,
      provision: provisionStub,
      inferCase: opts.inferCase,
      searchDockets: opts.searchDockets,
      searchByDocketNumber: opts.searchByDocketNumber,
    };
    await pollOnce(deps);
    return {
      replies,
      queue: await loadQueue(queuePath),
      ledger: await loadLedger(ledgerPath),
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  }

  const caseNumberMention = (): MentionNotif => ({
    uri: "m-alice",
    cid: "ca",
    authorDid: "did:alice",
    authorHandle: "alice.test",
    text: "@ape.rcape.org pull 0:26-cr-00115 please",
    root: { uri: "m-root", cid: "cr" },
  });

  it("resolves a case number via docket-number search ahead of Gemini (count===1 provisions)", async () => {
    const inferCase = vi.fn(async () => hint);
    const searchByDocketNumber = vi.fn(async () => oneMatch);
    const r = await run({
      mention: caseNumberMention(),
      thread: null,
      inferCase,
      searchDockets: vi.fn(async () => null),
      searchByDocketNumber,
    });
    try {
      expect(searchByDocketNumber).toHaveBeenCalledWith(
        "0:26-cr-00115",
        null, // district number is self-unique → unscoped search
        expect.any(String),
      );
      expect(inferCase).not.toHaveBeenCalled(); // case number wins; Gemini skipped
      expect(r.replies).toHaveLength(2); // ack + provisioned
      expect(r.replies[0]?.text).toContain("69777799");
      expect(r.queue.jobs[0]?.docketId).toBe(69777799);
    } finally {
      await r.cleanup();
    }
  });

  it("resolves a bankruptcy citation by court-scoped docket-number search", async () => {
    const inferCase = vi.fn(async () => hint);
    const searchByDocketNumber = vi.fn(async () => oneMatch);
    const r = await run({
      mention: {
        uri: "m-bk",
        cid: "cb",
        authorDid: "did:alice",
        authorHandle: "alice.test",
        text: "@ape.rcape.org Rollcage Technology, Inc., 22-20743, (Bankr. D. Conn.)",
        root: { uri: "m-root", cid: "cr" },
      },
      thread: null,
      inferCase,
      searchDockets: vi.fn(async () => null),
      searchByDocketNumber,
    });
    try {
      // BK numbers collide across courts → the parsed court (ctb) scopes the search.
      expect(searchByDocketNumber).toHaveBeenCalledWith(
        "22-20743",
        "ctb",
        expect.any(String),
      );
      expect(inferCase).not.toHaveBeenCalled(); // precise number+court wins; Gemini skipped
      expect(r.replies).toHaveLength(2); // ack + provisioned
      expect(r.queue.jobs[0]?.docketId).toBe(69777799);
    } finally {
      await r.cleanup();
    }
  });

  it("suggests (no Gemini) when a case number maps to multiple dockets", async () => {
    const inferCase = vi.fn(async () => hint);
    const searchByDocketNumber = vi.fn(async () => ({
      count: 16,
      results: [
        {
          docket_id: 1,
          caseName: "United States v. Sant",
          court_id: "mnd",
          docketNumber: "0:26-cr-00115",
          dateFiled: "2026-06-14",
        },
      ],
    }));
    const r = await run({
      mention: caseNumberMention(),
      thread: null,
      inferCase,
      searchDockets: vi.fn(async () => null),
      searchByDocketNumber,
    });
    try {
      expect(inferCase).not.toHaveBeenCalled();
      expect(r.replies).toHaveLength(1);
      expect(r.replies[0]?.text).toContain("0:26-cr-00115");
      expect(r.replies[0]?.text).toContain("16");
      expect(r.queue.jobs).toHaveLength(0);
    } finally {
      await r.cleanup();
    }
  });

  it("suppresses the suggest AND skips the CL docket-number search on a REPLY (no contentless noise)", async () => {
    // A bare PACER number arriving as a REPLY (not an @-mention) must not draw a
    // "did you mean" suggest, and must not burn a searchByDocketNumber CL call —
    // exactly the contentless-reply noise the suppression exists to prevent.
    const inferCase = vi.fn(async () => hint);
    const searchByDocketNumber = vi.fn(async () => ({
      count: 16,
      results: [
        {
          docket_id: 1,
          caseName: "United States v. Sant",
          court_id: "mnd",
          docketNumber: "0:26-cr-00115",
          dateFiled: "2026-06-14",
        },
      ],
    }));
    const r = await run({
      mention: { ...caseNumberMention(), source: "reply" },
      thread: null,
      inferCase,
      searchDockets: vi.fn(async () => null),
      searchByDocketNumber,
    });
    try {
      expect(searchByDocketNumber).not.toHaveBeenCalled(); // no wasted CL call
      expect(inferCase).not.toHaveBeenCalled(); // no Gemini either
      expect(r.replies).toHaveLength(0); // silence, not a suggest
      expect(r.queue.jobs).toHaveLength(0);
    } finally {
      await r.cleanup();
    }
  });

  it("CLARIFIES (never auto-provisions) on an exactly-one caption match, charging exactly 1 CL call for the search", async () => {
    const inferCase = vi.fn(async () => hint);
    const searchDockets = vi.fn(async () => oneMatch);
    const r = await run({ inferCase, searchDockets });
    try {
      expect(inferCase).toHaveBeenCalledTimes(1);
      // The hint flows verbatim into the search, with the selected token.
      expect(searchDockets).toHaveBeenCalledWith(
        "Abrego Garcia v. Noem",
        "mdd",
        "t",
      );
      // A name guess never shelves — even one match clarifies with the requester.
      expect(r.replies).toHaveLength(1);
      // The confirm reply names the MATCHED caseName (what was found), not just
      // the guess, and uses the singular confirm framing.
      expect(r.replies[0]?.text).toContain("Abrego Garcia v. Noem");
      expect(r.replies[0]?.text.toLowerCase()).toContain(
        "won't shelve a case from a name guess",
      );
      expect(r.queue.jobs).toHaveLength(0);
      // The search charged exactly 1 against the day's 125.
      expect(quotaRemaining(r.ledger, todayStr, "t")).toBe(124);
    } finally {
      await r.cleanup();
    }
  });

  it("feeds the mention text and thread prose to the inference seam", async () => {
    const inferCase = vi.fn(async () => null);
    const r = await run({ inferCase, searchDockets: vi.fn(async () => null) });
    try {
      const [mentionText, entries] = inferCase.mock.calls[0] as unknown as [
        string,
        { text: string }[],
      ];
      expect(mentionText).toContain("shelve the Abrego Garcia case");
      expect(entries.map((e) => e.text)).toContain(
        "huge ruling out of Maryland today",
      );
    } finally {
      await r.cleanup();
    }
  });

  it("replies suggest (not enqueue) when the search finds nothing", async () => {
    const r = await run({
      inferCase: async () => hint,
      searchDockets: async () => ({ count: 0, results: [] }),
    });
    try {
      expect(r.replies).toHaveLength(1);
      expect(r.replies[0]?.text).toContain("Abrego Garcia v. Noem");
      expect(r.queue.jobs).toHaveLength(0);
    } finally {
      await r.cleanup();
    }
  });

  it("replies 'did you mean' (not enqueue) when the search is ambiguous", async () => {
    const r = await run({
      inferCase: async () => hint,
      searchDockets: async () => ({ ...oneMatch, count: 3 }),
    });
    try {
      expect(r.replies).toHaveLength(1);
      expect(r.replies[0]?.text.toLowerCase()).toContain("did you mean");
      expect(r.replies[0]?.text).toContain("3");
      expect(r.queue.jobs).toHaveLength(0);
    } finally {
      await r.cleanup();
    }
  });

  it("degrades to the no-docket reply when inference returns null, without searching", async () => {
    const searchDockets = vi.fn(async () => oneMatch);
    const r = await run({ inferCase: async () => null, searchDockets });
    try {
      expect(searchDockets).not.toHaveBeenCalled();
      expect(r.replies).toHaveLength(1);
      expect(r.replies[0]?.text).toContain("couldn't find a docket");
      // No search → no quota spent.
      expect(quotaRemaining(r.ledger, todayStr, "t")).toBe(125);
    } finally {
      await r.cleanup();
    }
  });

  it("degrades to the no-docket reply when the search itself fails (seam returns null)", async () => {
    const r = await run({
      inferCase: async () => hint,
      searchDockets: async () => null,
    });
    try {
      expect(r.replies).toHaveLength(1);
      expect(r.replies[0]?.text).toContain("couldn't find a docket");
      expect(r.queue.jobs).toHaveLength(0);
    } finally {
      await r.cleanup();
    }
  });

  it("skips the search when no token has quota headroom", async () => {
    const searchDockets = vi.fn(async () => oneMatch);
    const r = await run({
      inferCase: async () => hint,
      searchDockets,
      prepLedger: (l) => chargeQuota(l, 125, todayStr, "t"),
    });
    try {
      expect(searchDockets).not.toHaveBeenCalled();
      expect(r.replies[0]?.text).toContain("couldn't find a docket");
    } finally {
      await r.cleanup();
    }
  });

  it("never runs inference for a non-allowlisted author", async () => {
    const inferCase = vi.fn(async () => hint);
    const r = await run({
      inferCase,
      searchDockets: vi.fn(async () => oneMatch),
      mention: { ...proseMention(), uri: "m-bob", authorDid: "did:bob" },
    });
    try {
      expect(inferCase).not.toHaveBeenCalled();
      expect(r.replies[0]?.text).toContain("@proptermalone");
    } finally {
      await r.cleanup();
    }
  });

  it("CLARIFIES (does not auto-shelve) even when the caption match is already provisioned", async () => {
    // The caption path no longer derives a docketId, so it can't dedupe to
    // "already in the stacks" from a name guess — it always clarifies. (This is
    // the second bug from the misdetection: a re-guess hit a shelved wrong case
    // and falsely replied "already in the stacks".)
    const r = await run({
      inferCase: async () => hint,
      searchDockets: async () => oneMatch,
      prepLedger: (l) =>
        recordCase(l, 69777799, {
          handle: "abrego-garcia.rcape.org",
          did: "did:case",
          password: "pw",
          createdAt: "2026-06-11",
          completed: true,
        }),
    });
    try {
      expect(r.replies).toHaveLength(1);
      expect(r.replies[0]?.text.toLowerCase()).toContain(
        "won't shelve a case from a name guess",
      );
      expect(r.queue.jobs).toHaveLength(0);
    } finally {
      await r.cleanup();
    }
  });

  it("infers from the mention text alone on a top-level mention (no thread), then clarifies", async () => {
    const inferCase = vi.fn(async () => hint);
    const r = await run({
      inferCase,
      searchDockets: async () => oneMatch,
      thread: null,
    });
    try {
      const [mentionText, entries] = inferCase.mock.calls[0] as unknown as [
        string,
        { text: string }[],
      ];
      expect(mentionText).toContain("Abrego Garcia");
      expect(entries).toHaveLength(0);
      // Name guess → clarify, never shelve.
      expect(r.queue.jobs).toHaveLength(0);
      expect(r.replies[0]?.text.toLowerCase()).toContain(
        "won't shelve a case from a name guess",
      );
    } finally {
      await r.cleanup();
    }
  });

  it("GUARD: the docket-NUMBER path still auto-provisions on count===1 (FIX 1 must not over-broaden)", async () => {
    const searchByDocketNumber = vi.fn(async () => oneMatch);
    const r = await run({
      mention: caseNumberMention(),
      thread: null,
      inferCase: vi.fn(async () => hint),
      searchDockets: vi.fn(async () => null),
      searchByDocketNumber,
    });
    try {
      // ack + provisioned — a parsed docket NUMBER is a hard signal, still shelves.
      expect(r.replies).toHaveLength(2);
      expect(r.queue.jobs[0]?.docketId).toBe(69777799);
    } finally {
      await r.cleanup();
    }
  });

  it("GUARD: a direct docket LINK still auto-provisions (FIX 1 must not over-broaden)", async () => {
    const inferCase = vi.fn(async () => hint);
    const r = await run({
      mention: {
        uri: "m-link",
        cid: "cl",
        authorDid: "did:alice",
        authorHandle: "alice.test",
        text: "@ape.rcape.org https://www.courtlistener.com/docket/69777799/x/",
        root: { uri: "m-root", cid: "cr" },
      },
      thread: null,
      inferCase,
      searchDockets: vi.fn(async () => null),
    });
    try {
      // A link is a hard signal: inference never runs, the case is shelved.
      expect(inferCase).not.toHaveBeenCalled();
      expect(r.replies).toHaveLength(2);
      expect(r.queue.jobs[0]?.docketId).toBe(69777799);
    } finally {
      await r.cleanup();
    }
  });
});

describe("notify-thread carve-out (Geidner): re-route replies out of his threads", () => {
  it("answers a mention in a notify-rooted thread as a NEW thread, not a reply", async () => {
    const { pollOnce } = await import("./bot.js");
    const dir = await mkdtemp(join(tmpdir(), "rcape-bot-"));
    try {
      const ledgerPath = join(dir, "ledger.json");
      const queuePath = join(dir, "queue.json");
      await saveLedger(ledgerPath, emptyLedger());
      // Alice (allowlisted) @-mentions the bot inside a thread ROOTED at a Chris post.
      const mention: MentionNotif = {
        uri: "m1",
        cid: "c1",
        authorDid: "did:alice",
        authorHandle: "alice.test",
        text: "@ape.rcape.org hello there",
        root: { uri: "at://did:chris/app.bsky.feed.post/r1", cid: "rc1" },
        source: "mention",
      };
      const { agent, replies, posts } = mockAgent([mention]);
      const deps: BotDeps = {
        agent,
        allowlist: new AllowlistCache(agent.graph, "owner.test"),
        cfg: {
          tokens: ["t"],
          domain: "rcape.org",
          hashN: 0,
          adminPassword: "",
          cfToken: "",
          zoneId: "",
          ledgerPath,
        } as ProvisionConfig,
        queuePath,
        notifyThreadDids: ["did:chris"],
      };

      await pollOnce(deps);

      // No threaded reply into Chris's thread...
      expect(replies).toHaveLength(0);
      // ...instead a standalone post that @-mentions the engager.
      const feedPosts = posts.filter(
        (p) => p.collection === "app.bsky.feed.post",
      );
      expect(feedPosts).toHaveLength(1);
      const rec = feedPosts[0]?.record as { text?: string; reply?: unknown };
      expect(rec.reply).toBeUndefined(); // top-level, not in Chris's thread
      expect(rec.text).toContain("@alice.test");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("replies normally (in-thread) when the thread is NOT notify-rooted", async () => {
    const { pollOnce } = await import("./bot.js");
    const dir = await mkdtemp(join(tmpdir(), "rcape-bot-"));
    try {
      const ledgerPath = join(dir, "ledger.json");
      const queuePath = join(dir, "queue.json");
      await saveLedger(ledgerPath, emptyLedger());
      const mention: MentionNotif = {
        uri: "m1",
        cid: "c1",
        authorDid: "did:alice",
        authorHandle: "alice.test",
        text: "@ape.rcape.org hello there",
        root: { uri: "at://did:stranger/app.bsky.feed.post/r1", cid: "rc1" },
        source: "mention",
      };
      const { agent, replies } = mockAgent([mention]);
      const deps: BotDeps = {
        agent,
        allowlist: new AllowlistCache(agent.graph, "owner.test"),
        cfg: {
          tokens: ["t"],
          domain: "rcape.org",
          hashN: 0,
          adminPassword: "",
          cfToken: "",
          zoneId: "",
          ledgerPath,
        } as ProvisionConfig,
        queuePath,
        notifyThreadDids: ["did:chris"],
      };

      await pollOnce(deps);

      // Ordinary thread → ordinary threaded reply (no-docket nudge).
      expect(replies).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("parseNotifyThreadDids", () => {
  it("keeps only did:-form entries, trimming whitespace", () => {
    const { dids, warn } = parseNotifyThreadDids(" did:plc:aaa , did:plc:bbb ");
    expect(dids).toEqual(["did:plc:aaa", "did:plc:bbb"]);
    expect(warn).toBe(false);
  });

  it("warns when entries exist but none are dids (handle-form config)", () => {
    const { dids, warn } = parseNotifyThreadDids(
      "@chrisgeidner.bsky.social, someone.bsky.social",
    );
    expect(dids).toEqual([]);
    expect(warn).toBe(true);
  });

  it("does not warn on an empty or unset env", () => {
    expect(parseNotifyThreadDids("")).toEqual({ dids: [], warn: false });
    expect(parseNotifyThreadDids(undefined)).toEqual({ dids: [], warn: false });
    expect(parseNotifyThreadDids("  ,  ")).toEqual({ dids: [], warn: false });
  });

  it("does not warn when at least one did is present alongside handles", () => {
    const { dids, warn } = parseNotifyThreadDids("@handle, did:plc:ccc");
    expect(dids).toEqual(["did:plc:ccc"]);
    expect(warn).toBe(false);
  });
});
