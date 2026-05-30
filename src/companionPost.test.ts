import { describe, expect, it } from "vitest";
import { entryToPost } from "./companionPost.js";
import type { DocketEntryRecord } from "./map.js";

const entry: DocketEntryRecord = {
  $type: "org.rcape.docketEntry",
  entryNumber: 1,
  recapSequenceNumber: "2025-03-24.001",
  dateFiled: "2025-03-24T00:00:00.000Z",
  description: "COMPLAINT against Kristi Noem et al.",
  documents: [
    { sourceUrl: "https://storage.courtlistener.com/x.pdf", pageCount: 21 },
  ],
  source: { provider: "courtlistener", retrievedAt: "t" },
  createdAt: "t",
};

describe("entryToPost", () => {
  it("stays within 300 graphemes and links the first document", () => {
    const p = entryToPost(
      entry,
      "Abrego Garcia v. Noem",
      "https://view.example",
      "2026-05-29T00:00:00.000Z",
    );
    expect(p.text.length).toBeLessThanOrEqual(300);
    expect(p.text).toContain("Abrego Garcia v. Noem");
    expect(p.embed?.external.uri).toBe(
      "https://storage.courtlistener.com/x.pdf",
    );
  });

  it("truncates very long descriptions with an ellipsis", () => {
    const long = { ...entry, description: "X".repeat(1000) };
    const p = entryToPost(long, "Case", "https://view.example", "t");
    expect(p.text.length).toBeLessThanOrEqual(300);
    expect(p.text).toContain("…");
  });

  it("falls back to the view URL when an entry has no documents", () => {
    const noDocs = { ...entry, documents: undefined };
    const p = entryToPost(noDocs, "Case", "https://view.example", "t");
    expect(p.embed?.external.uri).toBe("https://view.example");
  });
});
