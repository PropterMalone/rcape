import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DirectoryAgent, regenerateDirectory } from "./directorySync.js";
import type { GistUpdateResult } from "./gistClient.js";
import { type CaseEntry, recordCase, saveLedger } from "./ledger.js";

// An in-memory DirectoryAgent: records keyed by `${collection}/${rkey}`.
function fakeAgent() {
  const records = new Map<string, unknown>();
  let createSeq = 0;
  const agent: DirectoryAgent = {
    did: "did:plc:bot",
    async createRecord(collection, record) {
      const rkey = `auto${createSeq++}`;
      records.set(`${collection}/${rkey}`, record);
      return { uri: `at://did:plc:bot/${collection}/${rkey}`, cid: "cid" };
    },
    async putRecord(collection, rkey, record) {
      records.set(`${collection}/${rkey}`, record);
      return { uri: `at://did:plc:bot/${collection}/${rkey}`, cid: "cid" };
    },
    async getRecord(collection, rkey) {
      return records.get(`${collection}/${rkey}`);
    },
    async listRecords(collection) {
      return [...records.entries()]
        .filter(([k]) => k.startsWith(`${collection}/`))
        .map(([k, value]) => ({ uri: `at://did:plc:bot/${k}`, value }));
    },
  };
  return { agent, records };
}

let dir: string;
let ledgerPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rcape-dir-"));
  ledgerPath = join(dir, "ledger.json");
  const l = recordCase({ cases: {}, quota: { day: "", counts: {} } }, 1, {
    did: "did:plc:case1",
    handle: "case1.rcape.org",
    password: "pw",
    createdAt: "2026-06-10T00:00:00.000Z",
    completed: true,
    caseName: "Acme v. Roadrunner",
    courtName: "D.D.C.",
    docketNumber: "1:25-cv-1",
    filings: 7,
  } as CaseEntry);
  await saveLedger(ledgerPath, l);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("regenerateDirectory", () => {
  it("PATCHes the gist with the case table when token + id are set", async () => {
    const { agent } = fakeAgent();
    const gistFn = vi.fn(async (): Promise<GistUpdateResult> => ({ ok: true }));
    await regenerateDirectory(
      { agent, cfg: { ledgerPath, gistToken: "tok", gistId: "GID" } },
      gistFn,
    );
    expect(gistFn).toHaveBeenCalledTimes(1);
    const [token, gistId, _file, content] = gistFn.mock.calls[0] as string[];
    expect(token).toBe("tok");
    expect(gistId).toBe("GID");
    expect(content).toContain("Acme v. Roadrunner");
    expect(content).toContain("case1.rcape.org");
  });

  it("skips the gist when the token or id is absent", async () => {
    const { agent } = fakeAgent();
    const gistFn = vi.fn(async (): Promise<GistUpdateResult> => ({ ok: true }));
    await regenerateDirectory({ agent, cfg: { ledgerPath } }, gistFn);
    expect(gistFn).not.toHaveBeenCalled();
  });

  it("creates + pins the combined intro post once, then is idempotent", async () => {
    const { agent, records } = fakeAgent();
    const gistFn = vi.fn(async (): Promise<GistUpdateResult> => ({ ok: true }));
    const cfg = { ledgerPath, gistToken: "tok", gistId: "GID" };

    await regenerateDirectory({ agent, cfg }, gistFn);
    const post = records.get("app.bsky.feed.post/shelfintro") as {
      text: string;
    };
    expect(post.text).toContain("https://gist.github.com/PropterMalone/GID");
    const profile = records.get("app.bsky.actor.profile/self") as {
      pinnedPost?: { uri: string };
    };
    expect(profile.pinnedPost?.uri).toContain("/shelfintro");

    // Second run: the pin already points at our intro → no profile rewrite.
    const putSpy = vi.spyOn(agent, "putRecord");
    await regenerateDirectory({ agent, cfg }, gistFn);
    const repinnedProfile = putSpy.mock.calls.some(
      (c) => c[0] === "app.bsky.actor.profile",
    );
    expect(repinnedProfile).toBe(false);
  });

  it("preserves displayName/description when re-pinning (read-merge-write)", async () => {
    const { agent, records } = fakeAgent();
    // A profile already exists with bio fields but no pin.
    records.set("app.bsky.actor.profile/self", {
      $type: "app.bsky.actor.profile",
      displayName: "R.C. Ape, PhD, MLIS, LL.M.",
      description: "Mirroring U.S. federal court dockets…",
    });
    await regenerateDirectory(
      { agent, cfg: { ledgerPath, gistToken: "t", gistId: "GID" } },
      async () => ({ ok: true }),
    );
    const profile = records.get("app.bsky.actor.profile/self") as {
      displayName?: string;
      description?: string;
      pinnedPost?: unknown;
    };
    expect(profile.displayName).toBe("R.C. Ape, PhD, MLIS, LL.M.");
    expect(profile.description).toContain("Mirroring");
    expect(profile.pinnedPost).toBeDefined();
  });

  it("creates the graph.list once and adds a listitem per completed case", async () => {
    const { agent, records } = fakeAgent();
    // Add a second completed case so two listitems are expected.
    const l = recordCase(
      {
        cases: {
          "1": {
            did: "did:plc:case1",
            handle: "case1.rcape.org",
            password: "pw",
            createdAt: "2026-06-10T00:00:00.000Z",
            completed: true,
          },
        },
        quota: { day: "", counts: {} },
      },
      2,
      {
        did: "did:plc:case2",
        handle: "case2.rcape.org",
        password: "pw",
        createdAt: "2026-06-11T00:00:00.000Z",
        completed: true,
      } as CaseEntry,
    );
    await saveLedger(ledgerPath, l);

    await regenerateDirectory({ agent, cfg: { ledgerPath } }, async () => ({
      ok: true,
    }));

    // The list record exists at the fixed rkey, as a curatelist.
    const list = records.get("app.bsky.graph.list/shelf") as {
      purpose: string;
      name: string;
    };
    expect(list.purpose).toBe("app.bsky.graph#curatelist");
    expect(list.name).toContain("R.C. Ape");
    // One listitem per completed case, each pointing at the deterministic list URI.
    const items = [...records.entries()].filter(([k]) =>
      k.startsWith("app.bsky.graph.listitem/"),
    );
    expect(items).toHaveLength(2);
    const subjects = items.map(([, v]) => (v as { subject: string }).subject);
    expect(subjects.sort()).toEqual(["did:plc:case1", "did:plc:case2"]);
    expect((items[0]?.[1] as { list: string }).list).toBe(
      "at://did:plc:bot/app.bsky.graph.list/shelf",
    );
  });

  it("does not duplicate listitems or recreate the list on a second run", async () => {
    const { agent, records } = fakeAgent();
    const run = () =>
      regenerateDirectory({ agent, cfg: { ledgerPath } }, async () => ({
        ok: true,
      }));
    await run();
    const listCreatedAt = (
      records.get("app.bsky.graph.list/shelf") as { createdAt: string }
    ).createdAt;
    await run();
    const items = [...records.keys()].filter((k) =>
      k.startsWith("app.bsky.graph.listitem/"),
    );
    expect(items).toHaveLength(1); // the single completed case, not duplicated
    // The list record was not rewritten (same createdAt).
    expect(
      (records.get("app.bsky.graph.list/shelf") as { createdAt: string })
        .createdAt,
    ).toBe(listCreatedAt);
  });

  it("never throws when the gist call rejects (best-effort)", async () => {
    const { agent } = fakeAgent();
    const gistFn = vi.fn(async (): Promise<GistUpdateResult> => {
      throw new Error("boom");
    });
    await expect(
      regenerateDirectory(
        { agent, cfg: { ledgerPath, gistToken: "t", gistId: "g" } },
        gistFn,
      ),
    ).resolves.toBeUndefined();
  });
});
