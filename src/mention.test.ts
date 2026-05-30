import { describe, expect, it } from "vitest";
import { parseDocketId, parseMention } from "./mention.js";

describe("parseDocketId", () => {
  it("accepts a bare numeric id", () => {
    expect(parseDocketId("69777799")).toBe(69777799);
  });

  it("extracts the id from a CourtListener docket URL", () => {
    expect(
      parseDocketId(
        "https://www.courtlistener.com/docket/69777799/abrego-garcia-v-noem/",
      ),
    ).toBe(69777799);
  });

  it("returns null for undefined or non-docket input", () => {
    expect(parseDocketId(undefined)).toBeNull();
    expect(parseDocketId("not-a-docket")).toBeNull();
  });
});

describe("parseMention", () => {
  it("extracts a docket id from a URL embedded in mention text", () => {
    expect(
      parseMention(
        "@ape.rcape.org please add https://www.courtlistener.com/docket/69777799/abrego-garcia-v-noem/ thanks",
      ),
    ).toEqual({ docketId: 69777799 });
  });

  it("accepts a bare 6+ digit CL docket id", () => {
    expect(parseMention("@ape.rcape.org docket 69777799 please")).toEqual({
      docketId: 69777799,
    });
  });

  it("ignores case-number digits and years (no docket url, no 6+ digit run)", () => {
    expect(
      parseMention("@ape.rcape.org can you add 8:25-cv-00951 from 2025?"),
    ).toEqual({ kind: "no-docket" });
  });

  it("returns no-docket for text with no docket reference", () => {
    expect(parseMention("@ape.rcape.org hello there")).toEqual({
      kind: "no-docket",
    });
  });
});
