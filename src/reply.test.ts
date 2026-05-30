import { describe, expect, it } from "vitest";
import { truncate } from "./companionPost.js";
import { type ReplyKind, buildReply } from "./reply.js";

const all: ReplyKind[] = [
  { kind: "ack", caseName: "Abrego Garcia v. Noem" },
  { kind: "queued", caseName: "Abrego Garcia v. Noem", ahead: 3 },
  {
    kind: "provisioned",
    caseName: "Abrego Garcia v. Noem",
    handle: "abrego-garcia.rcape.org",
  },
  { kind: "exists", handle: "abrego-garcia.rcape.org" },
  { kind: "declined" },
  { kind: "no-docket" },
  { kind: "not-found" },
];

describe("buildReply", () => {
  it("every variant stays within the 300-grapheme post limit", () => {
    for (const r of all) {
      expect(
        [...new Intl.Segmenter().segment(buildReply(r))].length,
      ).toBeLessThanOrEqual(300);
    }
  });

  it("surfaces the new handle on success and exists", () => {
    expect(
      buildReply({
        kind: "provisioned",
        caseName: "Abrego Garcia v. Noem",
        handle: "abrego-garcia.rcape.org",
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
    });
    expect(out).toContain("@case-9.rcape.org");
    expect([...new Intl.Segmenter().segment(out)].length).toBeLessThanOrEqual(
      300,
    );
  });

  it("declines by pointing at @proptermalone", () => {
    expect(buildReply({ kind: "declined" })).toContain("@proptermalone");
  });

  it("asks for a CourtListener docket when none was given", () => {
    expect(buildReply({ kind: "no-docket" })).toContain(
      "courtlistener.com/docket",
    );
  });

  it("reports the queue position on a quota-deferred request", () => {
    expect(
      buildReply({ kind: "queued", caseName: "Doe v. Roe", ahead: 5 }),
    ).toContain("5");
  });

  it("clamps a long case name in the ack", () => {
    const longName = "x".repeat(200);
    const out = buildReply({ kind: "ack", caseName: longName });
    // the clamped name is shorter than the raw input
    expect(out).toContain(truncate(longName, 80));
    expect(out).not.toContain("x".repeat(200));
  });
});
