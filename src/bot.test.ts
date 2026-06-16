import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AllowlistCache, type GraphClient } from "./allowlist.js";
import { type BotDeps, classify } from "./bot.js";
import type { BotAgent, MentionNotif } from "./botAgent.js";
import {
  chargeQuota,
  emptyLedger,
  loadLedger,
  quotaRemaining,
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
  }[] = [];
  const seenAts: string[] = [];
  const agent: BotAgent = {
    did: "did:bot",
    graph: allowGraph(["did:alice"]),
    listMentions: async () => mentions,
    reply: async (parent, _root, text, facets) => {
      replies.push({ parent, text, facets });
      return { uri: `reply-${replies.length}`, cid: `c${replies.length}` };
    },
    updateSeen: async (seenAt) => {
      seenAts.push(seenAt);
    },
    getPostThread: async () => thread,
  };
  return { agent, replies, seenAts };
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
    };
    await pollOnce(deps);
    return {
      replies,
      queue: await loadQueue(queuePath),
      ledger: await loadLedger(ledgerPath),
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  }

  it("provisions on an exactly-one search match, charging exactly 1 CL call for the search", async () => {
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
      // Full ack + provision cycle on the searched docket id.
      expect(r.replies).toHaveLength(2);
      expect(r.replies[0]?.text).toContain("69777799");
      expect(r.replies[1]?.text).toContain("@abrego-garcia.rcape.org");
      expect(r.queue.jobs[0]?.docketId).toBe(69777799);
      // The search charged exactly 1 against the day's 125 (provision is
      // stubbed, so nothing else charges).
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

  it("applies the already-provisioned dedupe to a search-derived docket id", async () => {
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
      expect(r.replies[0]?.text).toContain("@abrego-garcia.rcape.org");
      expect(r.queue.jobs).toHaveLength(0);
    } finally {
      await r.cleanup();
    }
  });

  it("infers from the mention text alone on a top-level mention (no thread)", async () => {
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
      expect(r.queue.jobs[0]?.docketId).toBe(69777799);
    } finally {
      await r.cleanup();
    }
  });
});
