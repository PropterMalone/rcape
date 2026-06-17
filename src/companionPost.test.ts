import { describe, expect, it } from "vitest";
import { backdatedCreatedAts, entryToPost, truncate } from "./companionPost.js";
import type { DocketEntryRecord } from "./map.js";

describe("backdatedCreatedAts", () => {
  it("makes same-day filings strictly increasing (so the AppView feed shows all)", () => {
    const out = backdatedCreatedAts([
      "2026-06-14T00:00:00.000Z",
      "2026-06-14T00:00:00.000Z",
      "2026-06-14T00:00:00.000Z",
      "2026-06-15T00:00:00.000Z",
    ]);
    expect(new Set(out).size).toBe(4); // all unique
    for (let i = 1; i < out.length; i++) {
      expect(Date.parse(out[i] as string)).toBeGreaterThan(
        Date.parse(out[i - 1] as string),
      );
    }
    // first of each day keeps its filing date; same-day bumps stay within the day
    expect(out[0]).toBe("2026-06-14T00:00:00.000Z");
    expect((out[2] as string).slice(0, 10)).toBe("2026-06-14");
    expect(out[3]).toBe("2026-06-15T00:00:00.000Z");
  });

  it("bumps a later entry whose date precedes the prior post, preserving order", () => {
    const out = backdatedCreatedAts([
      "2026-06-15T00:00:00.000Z",
      "2026-06-14T00:00:00.000Z",
    ]);
    expect(Date.parse(out[1] as string)).toBeGreaterThan(
      Date.parse(out[0] as string),
    );
  });

  it("tolerates an unparseable date by stepping past the prior post", () => {
    const out = backdatedCreatedAts(["2026-06-14T00:00:00.000Z", "not-a-date"]);
    expect(Date.parse(out[1] as string)).toBeGreaterThan(
      Date.parse(out[0] as string),
    );
  });
});

const entry: DocketEntryRecord = {
  $type: "org.rcape.docketEntry",
  entryNumber: 1,
  recapSequenceNumber: "2025-03-24.001",
  dateFiled: "2025-03-24T00:00:00.000Z",
  description: "COMPLAINT against Kristi Noem et al.",
  documents: [
    {
      sourceUrl: "https://storage.courtlistener.com/x.pdf",
      pageCount: 21,
      isAvailable: true,
    },
  ],
  source: { provider: "courtlistener", retrievedAt: "t" },
  createdAt: "t",
};

describe("entryToPost", () => {
  it("renders an available document as a 📄 PDF card linking the storage file", () => {
    const p = entryToPost(
      entry,
      "Abrego Garcia v. Noem",
      "https://view.example",
      "2026-05-29T00:00:00.000Z",
    );
    expect(p.text.length).toBeLessThanOrEqual(300);
    expect(p.text).toContain("Abrego Garcia v. Noem");
    expect(p.text.startsWith("📄")).toBe(true);
    // Card links the PDF and tags it as a document with a page count.
    expect(p.embed?.external.uri).toBe(
      "https://storage.courtlistener.com/x.pdf",
    );
    expect(p.embed?.external.title).toContain("Doc 1");
    expect(p.embed?.external.description).toContain("21 pp · PDF");
  });

  it("renders a docket-only entry as a 🗂 card linking the docket page", () => {
    // A document whose scan CL has NOT gathered (isAvailable false) must NOT be
    // linked as a PDF — that link can 404. It's a docket entry, not a document.
    const ungathered = {
      ...entry,
      documents: [
        {
          sourceUrl: "https://storage.courtlistener.com/x.pdf",
          isAvailable: false,
        },
      ],
    };
    const p = entryToPost(ungathered, "Case", "https://view.example", "t");
    expect(p.text.startsWith("🗂")).toBe(true);
    expect(p.embed?.external.uri).toBe("https://view.example");
    expect(p.embed?.external.title).toContain("Docket entry 1");
    expect(p.embed?.external.description).toContain("docket only");
  });

  it("truncates very long descriptions with an ellipsis", () => {
    const long = { ...entry, description: "X".repeat(1000) };
    const p = entryToPost(long, "Case", "https://view.example", "t");
    expect(p.text.length).toBeLessThanOrEqual(300);
    expect(p.text).toContain("…");
  });

  it("falls back to the docket (view) URL when an entry has no documents", () => {
    const noDocs = { ...entry, documents: undefined };
    const p = entryToPost(noDocs, "Case", "https://view.example", "t");
    expect(p.embed?.external.uri).toBe("https://view.example");
    expect(p.embed?.external.title).toContain("Docket entry 1");
  });
});

describe("truncate (grapheme-aware)", () => {
  it("passes short strings through unchanged", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("handles flag emoji — counts grapheme clusters, not code units", () => {
    // 🇺🇸 is 2 UTF-16 code units but 1 grapheme cluster; 301 clusters → must truncate
    const input = "🇺🇸".repeat(301);
    const result = truncate(input, 300);
    const graphemes = [...new Intl.Segmenter().segment(result)];
    expect(graphemes.length).toBeLessThanOrEqual(300);
    expect(result.endsWith("…")).toBe(true);
  });

  it("appends ellipsis within the grapheme budget when truncating", () => {
    const input = "a".repeat(400);
    const result = truncate(input, 300);
    const graphemes = [...new Intl.Segmenter().segment(result)];
    expect(graphemes.length).toBeLessThanOrEqual(300);
    expect(result.endsWith("…")).toBe(true);
  });
});
