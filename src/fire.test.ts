import { describe, expect, it, vi } from "vitest";
import type { CaseRepo } from "./caseRepo.js";
import { type LiveEntry, postEntries } from "./fire.js";
import type { DocketEntryRecord } from "./map.js";

function entry(seq: string, dateFiled: string, num: number): LiveEntry {
  return {
    rkey: `rk-${seq}`,
    value: {
      $type: "org.rcape.docketEntry",
      entryNumber: num,
      recapSequenceNumber: seq,
      dateFiled,
      description: `Doc ${num}`,
      documents: [],
      source: { provider: "courtlistener", retrievedAt: "t" },
      createdAt: "t",
    } as DocketEntryRecord,
  };
}

// A fake repo that records the POST createRecord calls and the ENTRY putRecord
// calls. createRecord can be made to throw for a chosen entry to exercise the
// per-entry failure path.
function fakeRepo(failOnText?: string) {
  const posts: { createdAt: string; text: string }[] = [];
  const linked: { rkey: string; hasDocPost: boolean }[] = [];
  let n = 0;
  const repo = {
    handle: "case.rcape.org",
    createRecord: vi.fn(
      async (_collection: string, rec: Record<string, unknown>) => {
        if (failOnText && String(rec.text).includes(failOnText)) {
          throw new Error("post failed");
        }
        n += 1;
        posts.push({
          createdAt: String(rec.createdAt),
          text: String(rec.text),
        });
        return { uri: `at://post/${n}`, cid: `cid${n}` };
      },
    ),
    putRecord: vi.fn(
      async (_c: string, rkey: string, rec: Record<string, unknown>) => {
        linked.push({ rkey, hasDocPost: "docPost" in rec });
      },
    ),
  };
  return { repo: repo as unknown as CaseRepo, posts, linked };
}

describe("postEntries", () => {
  it("posts one backdated companion per entry and links it back onto the entry", async () => {
    const { repo, posts, linked } = fakeRepo();
    const entries = [
      entry("2025-03-24.001", "2025-03-24T00:00:00.000Z", 1),
      entry("2025-03-24.002", "2025-03-24T00:00:00.000Z", 2),
    ];
    const res = await postEntries(repo, entries, "Doe v. Roe", "https://cl/x");

    expect(res).toEqual({ published: 2, failed: [] });
    expect(posts).toHaveLength(2);
    // Each posted entry got its docPost strongRef written back.
    expect(linked).toEqual([
      { rkey: "rk-2025-03-24.001", hasDocPost: true },
      { rkey: "rk-2025-03-24.002", hasDocPost: true },
    ]);
    // Two same-day entries get DISTINCT createdAts (the AppView-collapse fix).
    expect(posts[0]?.createdAt).not.toBe(posts[1]?.createdAt);
    expect(
      Date.parse(posts[1]?.createdAt ?? "") >
        Date.parse(posts[0]?.createdAt ?? ""),
    ).toBe(true);
  });

  it("collects a per-entry failure without throwing and still posts the rest", async () => {
    const { repo, linked } = fakeRepo("Doc 1"); // entry #1's post throws
    const entries = [
      entry("2025-03-24.001", "2025-03-24T00:00:00.000Z", 1),
      entry("2025-03-24.002", "2025-03-24T00:00:00.000Z", 2),
    ];
    const res = await postEntries(repo, entries, "Doe v. Roe", "https://cl/x");

    expect(res.published).toBe(1);
    expect(res.failed).toEqual(["rk-2025-03-24.001"]);
    // Only the successful entry was linked (the failed one stays below high-water).
    expect(linked).toEqual([{ rkey: "rk-2025-03-24.002", hasDocPost: true }]);
  });
});
