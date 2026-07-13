import { describe, expect, it } from "vitest";
import { type BuiltReply, type ReplyKind, buildReply } from "./reply.js";

const graphemes = (s: string): number =>
  [...new Intl.Segmenter().segment(s)].length;

// The text the link facet's byte range actually covers — what the client will
// render as the tappable span. Byte (not char) slicing mirrors the AT richtext
// spec, so an offset bug (e.g. counting chars past the 🔎) fails these tests.
const facetSpan = (r: BuiltReply, i = 0): string => {
  const f = r.facets[i];
  if (!f) throw new Error("no facet at index");
  return Buffer.from(r.text, "utf8")
    .subarray(f.index.byteStart, f.index.byteEnd)
    .toString("utf8");
};

const all: ReplyKind[] = [
  { kind: "ack", docketId: 69777799 },
  { kind: "queued", docketId: 69777799, ahead: 3 },
  {
    kind: "provisioned",
    caseName: "Abrego Garcia v. Noem",
    handle: "abrego-garcia.rcape.org",
    failed: 0,
  },
  { kind: "exists", handle: "abrego-garcia.rcape.org" },
  { kind: "over-cap", inFlight: 3, docketId: 69777799 },
  { kind: "declined" },
  { kind: "no-docket" },
  { kind: "not-found" },
  { kind: "suggest", caption: "United States v. Smith", matches: 0 },
  { kind: "suggest", caption: "United States v. Smith", matches: 4 },
  { kind: "deferred", docketId: 69777799 },
  { kind: "throttled", docketId: 69777799 },
  { kind: "failed", docketId: 69777799 },
];

describe("buildReply", () => {
  it("every variant stays within the 300-grapheme post limit", () => {
    for (const r of all) {
      expect(graphemes(buildReply(r).text)).toBeLessThanOrEqual(300);
    }
  });

  it("surfaces the new handle on success and exists", () => {
    expect(
      buildReply({
        kind: "provisioned",
        caseName: "Abrego Garcia v. Noem",
        handle: "abrego-garcia.rcape.org",
        failed: 0,
      }).text,
    ).toContain("@abrego-garcia.rcape.org");
    expect(
      buildReply({ kind: "exists", handle: "x.rcape.org" }).text,
    ).toContain("@x.rcape.org");
  });

  it("keeps the handle even when the case name is very long", () => {
    const longName = "The Exceptionally Verbose Matter Of ".repeat(20);
    const out = buildReply({
      kind: "provisioned",
      caseName: longName,
      handle: "case-9.rcape.org",
      failed: 0,
    }).text;
    expect(out).toContain("@case-9.rcape.org");
    expect(graphemes(out)).toBeLessThanOrEqual(300);
  });

  it("notes the failed-post count when some filings didn't post, omits it at zero", () => {
    const clean = buildReply({
      kind: "provisioned",
      caseName: "Doe v. Roe",
      handle: "doe.rcape.org",
      failed: 0,
    }).text;
    // No failures → no "couldn't be posted" note.
    expect(clean.toLowerCase()).not.toContain("couldn't be posted");
    const partial = buildReply({
      kind: "provisioned",
      caseName: "Doe v. Roe",
      handle: "doe.rcape.org",
      failed: 3,
    }).text;
    expect(partial).toContain("3");
    expect(graphemes(partial)).toBeLessThanOrEqual(300);
  });

  it("distinguishes the hourly throttle (soon) from the daily defer (tomorrow)", () => {
    const throttled = buildReply({
      kind: "throttled",
      docketId: 69777799,
    }).text;
    expect(throttled).toContain("69777799");
    expect(throttled.toLowerCase()).toContain("rate limit");
    expect(throttled).not.toContain("tomorrow");
    const deferred = buildReply({ kind: "deferred", docketId: 69777799 }).text;
    expect(deferred).toContain("tomorrow");
  });

  it("references the docket id in the ack (case name not yet known)", () => {
    expect(buildReply({ kind: "ack", docketId: 69777799 }).text).toContain(
      "69777799",
    );
  });

  it("declines by pointing at @proptermalone", () => {
    expect(buildReply({ kind: "declined" }).text).toContain("@proptermalone");
  });

  it("gives the declined requester an actionable path (follow + re-mention)", () => {
    const text = buildReply({ kind: "declined" }).text;
    expect(text).toContain("Follow");
    expect(text.toLowerCase()).toContain("mention me again");
  });

  it("names the turned-away docket in the over-cap reply", () => {
    expect(
      buildReply({ kind: "over-cap", inFlight: 3, docketId: 69777799 }).text,
    ).toContain("69777799");
  });

  it("asks for a CourtListener docket when none was given", () => {
    expect(buildReply({ kind: "no-docket" }).text).toContain(
      "courtlistener.com/docket",
    );
  });

  it("names the guessed caption when the search found nothing", () => {
    const text = buildReply({
      kind: "suggest",
      caption: "United States v. Smith",
      matches: 0,
    }).text;
    expect(text).toContain("United States v. Smith");
    expect(text.toLowerCase()).toContain("courtlistener");
  });

  it("asks 'did you mean' with the match count when the search was ambiguous", () => {
    const text = buildReply({
      kind: "suggest",
      caption: "United States v. Smith",
      matches: 4,
    }).text;
    expect(text).toContain("United States v. Smith");
    expect(text).toContain("4");
    expect(text.toLowerCase()).toContain("did you mean");
  });

  it("confirms (singular, won't-shelve framing) when the caption matched exactly one docket", () => {
    const text = buildReply({
      kind: "suggest",
      caption: "Heritage Foundation v. DOJ",
      matches: 1,
    }).text;
    expect(text).toContain("Heritage Foundation v. DOJ");
    expect(text.toLowerCase()).toContain(
      "won't shelve a case from a name guess",
    );
    // Singular confirm framing, not the ambiguous "did you mean … N dockets".
    expect(text.toLowerCase()).not.toContain("did you mean");
  });

  it("clamps a long guessed caption while keeping the reply under the post limit", () => {
    const text = buildReply({
      kind: "suggest",
      caption: "An Extraordinarily Long Caption ".repeat(20),
      matches: 2,
    }).text;
    expect(graphemes(text)).toBeLessThanOrEqual(300);
  });

  it("reports the queue position on a quota-deferred request", () => {
    expect(
      buildReply({ kind: "queued", docketId: 123456, ahead: 5 }).text,
    ).toContain("5");
  });

  describe("CourtListener search link on failure-to-find replies", () => {
    it("suggest links a search prefilled with the guessed caption", () => {
      for (const matches of [0, 1, 4]) {
        const r = buildReply({
          kind: "suggest",
          caption: "United States v. Smith",
          matches,
        });
        expect(r.facets).toHaveLength(1);
        const feature = r.facets[0]?.features[0];
        expect(feature?.$type).toBe("app.bsky.richtext.facet#link");
        expect(feature?.uri).toBe(
          "https://www.courtlistener.com/?q=United+States+v.+Smith&type=r",
        );
      }
    });

    it("no-docket and not-found link the RECAP search page", () => {
      for (const kind of ["no-docket", "not-found"] as const) {
        const r = buildReply({ kind });
        expect(r.facets).toHaveLength(1);
        expect(r.facets[0]?.features[0]?.uri).toBe(
          "https://www.courtlistener.com/recap/",
        );
      }
    });

    it("facet byte range covers exactly the visible display link", () => {
      const r = buildReply({
        kind: "suggest",
        caption: "Garcia—Guirre v. Samsung", // em dash: multibyte before the link
        matches: 2,
      });
      const span = facetSpan(r);
      expect(span.startsWith("courtlistener.com/")).toBe(true);
      expect(r.text.endsWith(span)).toBe(true);
    });

    it("a long caption keeps the reply under 300 graphemes with the link intact", () => {
      const r = buildReply({
        kind: "suggest",
        caption: "An Extraordinarily Long Caption ".repeat(20),
        matches: 2,
      });
      expect(graphemes(r.text)).toBeLessThanOrEqual(300);
      // The display span survives truncation whole — a chopped link is worse
      // than none.
      expect(r.text.endsWith(facetSpan(r))).toBe(true);
      expect(r.facets[0]?.features[0]?.uri).toContain("&type=r");
    });

    it("non-failure kinds carry no link facets", () => {
      for (const r of all) {
        if (
          r.kind === "no-docket" ||
          r.kind === "not-found" ||
          r.kind === "suggest"
        )
          continue;
        expect(buildReply(r).facets).toHaveLength(0);
      }
    });
  });
});
