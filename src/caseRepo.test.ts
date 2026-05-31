import { describe, expect, it, vi } from "vitest";
import { CaseRepo, type RepoClient } from "./caseRepo.js";

type Write = { $type: string; collection: string; rkey: string };

function mockClient(
  pages: {
    records: { uri: string; cid: string; value: unknown }[];
    cursor?: string;
  }[],
): {
  client: RepoClient;
  writes: Write[][];
  listCalls: { collection: string; cursor?: string }[];
} {
  const listCalls: { collection: string; cursor?: string }[] = [];
  const writes: Write[][] = [];
  let pageIdx = 0;
  const client: RepoClient = {
    com: {
      atproto: {
        repo: {
          listRecords: vi.fn(async (p) => {
            listCalls.push({ collection: p.collection, cursor: p.cursor });
            const page = pages[pageIdx++] ?? { records: [] };
            return { data: page };
          }),
          getRecord: vi.fn(async () => ({
            data: { uri: "at://x", cid: "c", value: { ok: true } },
          })),
          putRecord: vi.fn(async () => ({})),
          createRecord: vi.fn(async () => ({
            data: { uri: "at://new", cid: "cid1" },
          })),
          applyWrites: vi.fn(async (p) => {
            writes.push(p.writes as Write[]);
            return {};
          }),
          uploadBlob: vi.fn(async () => ({
            data: { blob: { $type: "blob", ref: "test" } },
          })),
        },
      },
    },
  };
  return { client, writes, listCalls };
}

describe("CaseRepo.listAll", () => {
  it("follows the cursor across pages and yields rkey from each uri", async () => {
    const { client, listCalls } = mockClient([
      {
        records: [
          { uri: "at://did/coll/a", cid: "1", value: {} },
          { uri: "at://did/coll/b", cid: "2", value: {} },
        ],
        cursor: "next",
      },
      { records: [{ uri: "at://did/coll/c", cid: "3", value: {} }] },
    ]);
    const repo = CaseRepo.fromClient(client, "did", "h");
    const rkeys: string[] = [];
    for await (const r of repo.listAll("coll")) rkeys.push(r.rkey);

    expect(rkeys).toEqual(["a", "b", "c"]);
    expect(listCalls).toEqual([
      { collection: "coll", cursor: undefined },
      { collection: "coll", cursor: "next" },
    ]);
  });

  it("stops when no cursor is returned", async () => {
    const { client, listCalls } = mockClient([{ records: [] }]);
    const repo = CaseRepo.fromClient(client, "did", "h");
    const all = await repo.collect("coll");
    expect(all).toEqual([]);
    expect(listCalls).toHaveLength(1);
  });

  it("skips records whose URI has no rkey segment", async () => {
    const { client } = mockClient([
      {
        records: [
          { uri: "at://did/coll/", cid: "1", value: {} }, // trailing slash, no rkey
          { uri: "at://did/coll/good", cid: "2", value: {} },
        ],
      },
    ]);
    const repo = CaseRepo.fromClient(client, "did", "h");
    const rkeys = (await repo.collect("coll")).map((r) => r.rkey);
    expect(rkeys).toEqual(["good"]);
  });
});

describe("CaseRepo.applyCreates / applyDeletes", () => {
  it("batches creates at the 20-record boundary", async () => {
    const { client, writes } = mockClient([]);
    const repo = CaseRepo.fromClient(client, "did", "h");
    const rows = Array.from({ length: 45 }, (_, i) => ({
      collection: "c",
      rkey: `r${i}`,
      value: {},
    }));
    await repo.applyCreates(rows);

    expect(writes.map((w) => w.length)).toEqual([20, 20, 5]);
    expect(writes[0]?.[0]?.$type).toBe("com.atproto.repo.applyWrites#create");
  });

  it("batches deletes and emits delete ops", async () => {
    const { client, writes } = mockClient([]);
    const repo = CaseRepo.fromClient(client, "did", "h");
    const targets = Array.from({ length: 21 }, (_, i) => ({
      collection: "c",
      rkey: `r${i}`,
    }));
    await repo.applyDeletes(targets);

    expect(writes.map((w) => w.length)).toEqual([20, 1]);
    expect(writes[0]?.[0]?.$type).toBe("com.atproto.repo.applyWrites#delete");
  });

  it("no-ops on empty input", async () => {
    const { client, writes } = mockClient([]);
    const repo = CaseRepo.fromClient(client, "did", "h");
    await repo.applyCreates([]);
    await repo.applyDeletes([]);
    expect(writes).toHaveLength(0);
  });
});
