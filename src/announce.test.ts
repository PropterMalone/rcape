import { describe, expect, it, vi } from "vitest";
import {
  type ProvisionedAnnouncement,
  announceProvision,
  announcementText,
} from "./announce.js";

interface PostRecord {
  reply?: unknown;
  embed?: { $type?: string; external?: { uri?: string } };
  facets?: { features?: { did?: string }[] }[];
}

const prov = (
  over: Partial<ProvisionedAnnouncement> = {},
): ProvisionedAnnouncement => ({
  handle: "doe-v-roe.rcape.org",
  did: "did:plc:case",
  caseName: "Doe v. Roe",
  docketNumber: "1:25-cv-00123",
  courtName: "S.D.N.Y.",
  published: 7,
  ...over,
});

describe("announcementText", () => {
  it("names the case + docket and mentions the case @handle", () => {
    const t = announcementText(prov());
    expect(t).toContain("Doe v. Roe");
    expect(t).toContain("1:25-cv-00123");
    expect(t).toContain("@doe-v-roe.rcape.org");
  });

  it("stays well under the 300-grapheme post cap even with a huge case name", () => {
    const t = announcementText(prov({ caseName: "X".repeat(1000) }));
    const graphemes = [...new Intl.Segmenter().segment(t)].length;
    expect(graphemes).toBeLessThanOrEqual(300);
    // The @handle (and its facet target) survives the cap.
    expect(t).toContain("@doe-v-roe.rcape.org");
  });
});

describe("announceProvision", () => {
  it("posts a standalone app.bsky.feed.post with a mention facet + case card", async () => {
    const createRecord = vi.fn(async () => ({ uri: "at://x", cid: "c" }));
    await announceProvision(
      { agent: { createRecord }, cardThumb: { b: 1 } },
      prov(),
    );
    expect(createRecord).toHaveBeenCalledTimes(1);
    const [collection, record] = createRecord.mock.calls[0] as unknown as [
      string,
      PostRecord,
    ];
    expect(collection).toBe("app.bsky.feed.post");
    expect(record.reply).toBeUndefined(); // standalone, NOT a reply
    expect(record.embed?.$type).toBe("app.bsky.embed.external");
    expect(record.embed?.external?.uri).toBe(
      "https://bsky.app/profile/doe-v-roe.rcape.org",
    );
    // mention facet points at the case DID
    const mentionDids = (record.facets ?? []).flatMap((f) =>
      (f.features ?? []).map((ft) => ft.did),
    );
    expect(mentionDids).toContain("did:plc:case");
  });

  it("does NOT reference the source journalist anywhere in the post", async () => {
    const createRecord = vi.fn(async () => ({ uri: "at://x", cid: "c" }));
    await announceProvision({ agent: { createRecord } }, prov());
    const [, record] = createRecord.mock.calls[0] as unknown as [
      string,
      PostRecord,
    ];
    const blob = JSON.stringify(record);
    expect(blob).not.toContain("source");
    expect(blob.toLowerCase()).not.toContain("geidner");
  });

  it("skips entirely when announcements are disabled", async () => {
    const createRecord = vi.fn();
    await announceProvision(
      { agent: { createRecord }, announce: false },
      prov(),
    );
    expect(createRecord).not.toHaveBeenCalled();
  });

  it("swallows a post failure (never throws — must not fail the provision)", async () => {
    const createRecord = vi.fn(async () => {
      throw new Error("pds down");
    });
    await expect(
      announceProvision({ agent: { createRecord } }, prov()),
    ).resolves.toBeUndefined();
  });
});
