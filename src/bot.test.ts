import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AllowlistCache, type GraphClient } from "./allowlist.js";
import { type BotDeps, classify } from "./bot.js";
import type { BotAgent, MentionNotif } from "./botAgent.js";
import { emptyLedger, saveLedger } from "./ledger.js";
import type { ProvisionConfig, ProvisionResult } from "./provisionCase.js";
import { type StrongRef, loadQueue } from "./queue.js";

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
  return {
    app: {
      bsky: {
        graph: {
          getFollows: vi.fn(async () => ({
            data: { follows: dids.map((did) => ({ did })) },
          })),
          getFollowers: vi.fn(async () => ({ data: { followers: [] } })),
        },
      },
    },
  };
}

function mockAgent(mentions: MentionNotif[]) {
  const replies: { parent: StrongRef; text: string }[] = [];
  const agent: BotAgent = {
    did: "did:bot",
    graph: allowGraph(["did:alice"]),
    listMentions: async () => mentions,
    reply: async (parent, _root, text) => {
      replies.push({ parent, text });
      return { uri: `reply-${replies.length}`, cid: `c${replies.length}` };
    },
  };
  return { agent, replies };
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
        token: "t",
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
        token: "t",
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
        token: "t",
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
      const q1 = await loadQueue(queuePath);
      expect(q1.jobs[0]?.status).toBe("done");
      expect(q1.seen).toContain("m-alice");

      // second cycle: alice's mention is already seen → no new replies.
      await pollOnce(deps);
      expect(replies).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
