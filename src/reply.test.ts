import { describe, expect, it } from "vitest";
import { type ReplyKind, buildReply } from "./reply.js";

const graphemes = (s: string): number =>
  [...new Intl.Segmenter().segment(s)].length;

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
];

describe("buildReply", () => {
  it("every variant stays within the 300-grapheme post limit", () => {
    for (const r of all) {
      expect(graphemes(buildReply(r))).toBeLessThanOrEqual(300);
    }
  });

  it("surfaces the new handle on success and exists", () => {
    expect(
      buildReply({
        kind: "provisioned",
        caseName: "Abrego Garcia v. Noem",
        handle: "abrego-garcia.rcape.org",
        failed: 0,
      }),
    ).toContain("@abrego-garcia.rcape.org");
    expect(buildReply({ kind: "exists", handle: "x.rcape.org" })).toContain(
      "@x.rcape.org",
    );
  });

  it("keeps the handle even when the case name is very long", () => {
    const longName = "The Exceptionally Verbose Matter Of ".repeat(20);
    const out = buildReply({
      kind: "provisioned",
      caseName: longName,
      handle: "case-9.rcape.org",
      failed: 0,
    });
    expect(out).toContain("@case-9.rcape.org");
    expect(graphemes(out)).toBeLessThanOrEqual(300);
  });

  it("notes the failed-post count when some filings didn't post, omits it at zero", () => {
    const clean = buildReply({
      kind: "provisioned",
      caseName: "Doe v. Roe",
      handle: "doe.rcape.org",
      failed: 0,
    });
    // No failures → no "couldn't be posted" note.
    expect(clean.toLowerCase()).not.toContain("couldn't be posted");
    const partial = buildReply({
      kind: "provisioned",
      caseName: "Doe v. Roe",
      handle: "doe.rcape.org",
      failed: 3,
    });
    expect(partial).toContain("3");
    expect(graphemes(partial)).toBeLessThanOrEqual(300);
  });

  it("references the docket id in the ack (case name not yet known)", () => {
    expect(buildReply({ kind: "ack", docketId: 69777799 })).toContain(
      "69777799",
    );
  });

  it("declines by pointing at @proptermalone", () => {
    expect(buildReply({ kind: "declined" })).toContain("@proptermalone");
  });

  it("gives the declined requester an actionable path (follow + re-mention)", () => {
    const text = buildReply({ kind: "declined" });
    expect(text).toContain("Follow");
    expect(text.toLowerCase()).toContain("mention me again");
  });

  it("names the turned-away docket in the over-cap reply", () => {
    expect(
      buildReply({ kind: "over-cap", inFlight: 3, docketId: 69777799 }),
    ).toContain("69777799");
  });

  it("asks for a CourtListener docket when none was given", () => {
    expect(buildReply({ kind: "no-docket" })).toContain(
      "courtlistener.com/docket",
    );
  });

  it("names the guessed caption when the search found nothing", () => {
    const text = buildReply({
      kind: "suggest",
      caption: "United States v. Smith",
      matches: 0,
    });
    expect(text).toContain("United States v. Smith");
    expect(text.toLowerCase()).toContain("courtlistener");
  });

  it("asks 'did you mean' with the match count when the search was ambiguous", () => {
    const text = buildReply({
      kind: "suggest",
      caption: "United States v. Smith",
      matches: 4,
    });
    expect(text).toContain("United States v. Smith");
    expect(text).toContain("4");
    expect(text.toLowerCase()).toContain("did you mean");
  });

  it("clamps a long guessed caption while keeping the reply under the post limit", () => {
    const text = buildReply({
      kind: "suggest",
      caption: "An Extraordinarily Long Caption ".repeat(20),
      matches: 2,
    });
    expect(graphemes(text)).toBeLessThanOrEqual(300);
  });

  it("reports the queue position on a quota-deferred request", () => {
    expect(
      buildReply({ kind: "queued", docketId: 123456, ahead: 5 }),
    ).toContain("5");
  });
});
