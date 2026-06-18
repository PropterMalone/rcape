import { describe, expect, it, vi } from "vitest";
import {
  type ListNotificationsPage,
  type MentionNotif,
  isRecordNotFound,
  paginateMentions,
} from "./botAgent.js";

// A page of raw listNotifications data, shaped like the AtpAgent response.
function page(
  notifs: Array<{ uri: string; reason: string; text?: string }>,
  cursor?: string,
): ListNotificationsPage {
  return {
    notifications: notifs.map((n) => ({
      uri: n.uri,
      cid: `c-${n.uri}`,
      reason: n.reason,
      author: { did: `did-${n.uri}`, handle: `${n.uri}.test` },
      record: { text: n.text ?? "hi" },
      indexedAt: "2026-05-31T00:00:00.000Z",
    })),
    cursor,
  };
}

describe("paginateMentions", () => {
  it("walks cursor pages so mentions past page 1 are still returned", async () => {
    const fetchPage = vi.fn(
      async (cursor?: string): Promise<ListNotificationsPage> => {
        if (!cursor) {
          // Page 1 is all non-mention noise plus one mention at the tail.
          return page(
            [
              { uri: "like1", reason: "like" },
              { uri: "follow1", reason: "follow" },
              { uri: "m1", reason: "mention" },
            ],
            "p2",
          );
        }
        // Page 2 has a real mention that would be dropped without pagination.
        return page([{ uri: "m2", reason: "mention" }], undefined);
      },
    );

    const out = await paginateMentions(fetchPage, { isSeen: () => false });
    expect(out.map((m: MentionNotif) => m.uri)).toEqual(["m1", "m2"]);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("stops paging once it reaches an already-seen notification", async () => {
    const fetchPage = vi.fn(
      async (cursor?: string): Promise<ListNotificationsPage> => {
        if (!cursor) {
          return page(
            [
              { uri: "m-new", reason: "mention" },
              { uri: "m-old", reason: "mention" }, // already seen → stop here
            ],
            "p2",
          );
        }
        // Should never be reached: we stopped at the seen notification on page 1.
        return page([{ uri: "m-ancient", reason: "mention" }], undefined);
      },
    );

    const seen = new Set(["m-old"]);
    const out = await paginateMentions(fetchPage, {
      isSeen: (u) => seen.has(u),
    });
    expect(out.map((m) => m.uri)).toEqual(["m-new"]);
    expect(fetchPage).toHaveBeenCalledTimes(1); // page 2 never fetched
  });

  it("stops when the cursor is absent", async () => {
    const fetchPage = vi.fn(async (): Promise<ListNotificationsPage> => {
      return page([{ uri: "m1", reason: "mention" }], undefined);
    });
    const out = await paginateMentions(fetchPage, { isSeen: () => false });
    expect(out.map((m) => m.uri)).toEqual(["m1"]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("collects reply notifications (a link handed back in conversation) and tags source", async () => {
    const fetchPage = vi.fn(async (): Promise<ListNotificationsPage> => {
      return page(
        [
          { uri: "m1", reason: "mention" },
          { uri: "like1", reason: "like" }, // still ignored
          { uri: "r1", reason: "reply" },
        ],
        undefined,
      );
    });
    const out = await paginateMentions(fetchPage, { isSeen: () => false });
    expect(out.map((m) => m.uri)).toEqual(["m1", "r1"]);
    expect(out.map((m) => m.source)).toEqual(["mention", "reply"]);
  });
});

describe("isRecordNotFound", () => {
  it("is true for an XRPCError naming RecordNotFound", () => {
    expect(isRecordNotFound({ error: "RecordNotFound", status: 400 })).toBe(
      true,
    );
    expect(
      isRecordNotFound(new Error("Could not locate record: app.bsky...")),
    ).toBe(true);
  });

  it("is false for a transient PDS/network/auth fault", () => {
    expect(isRecordNotFound(new Error("UpstreamFailure"))).toBe(false);
    expect(isRecordNotFound({ status: 500, message: "boom" })).toBe(false);
    expect(isRecordNotFound({ error: "AuthRequired" })).toBe(false);
    expect(isRecordNotFound(null)).toBe(false);
    expect(isRecordNotFound("nope")).toBe(false);
  });
});
