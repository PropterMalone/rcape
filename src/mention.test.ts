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

  it("rejects non-positive and overflow-range values", () => {
    expect(parseDocketId("0")).toBeNull();
    // >= 1e10 is well beyond CL docket id width — almost certainly a timestamp.
    expect(parseDocketId("10000000000")).toBeNull();
    expect(parseDocketId("99999999999999")).toBeNull();
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

  it("accepts a bare 7+ digit CL docket id when a keyword is present", () => {
    expect(parseMention("@ape.rcape.org docket 69777799 please")).toEqual({
      docketId: 69777799,
    });
    expect(parseMention("@ape.rcape.org add case 1234567")).toEqual({
      docketId: 1234567,
    });
  });

  it("ignores case-number digits and years (no docket url, no qualifying run)", () => {
    expect(
      parseMention("@ape.rcape.org can you add 8:25-cv-00951 from 2025?"),
    ).toEqual({ kind: "no-docket" });
  });

  it("does NOT parse a bare 6-digit number (too short for a CL docket id)", () => {
    // A 6-digit ZIP+4 stub / short number must not trigger a quota-burning fetch,
    // even with a keyword nearby.
    expect(parseMention("@ape.rcape.org please add case 902210")).toEqual({
      kind: "no-docket",
    });
  });

  it("does NOT parse an embedded phone number or ZIP as a docket", () => {
    // Phone (10 digits) with no docket keyword/URL — bare-number path must not fire.
    expect(parseMention("@ape.rcape.org call me at 5551234567 thanks")).toEqual(
      { kind: "no-docket" },
    );
    // 5-digit ZIP — below the floor regardless.
    expect(parseMention("@ape.rcape.org I'm in 90210 btw")).toEqual({
      kind: "no-docket",
    });
  });

  it("does NOT parse a bare 7+ digit number without a docket keyword or URL", () => {
    // A standalone long integer (timestamp, AT-URI rkey digits) with no signal
    // it is a docket request — must not burn a fetch.
    expect(
      parseMention("@ape.rcape.org the number 1700000000 is cool"),
    ).toEqual({ kind: "no-docket" });
  });

  it("still parses a CL docket URL even without a keyword", () => {
    expect(
      parseMention(
        "@ape.rcape.org https://www.courtlistener.com/docket/69777799/x/",
      ),
    ).toEqual({ docketId: 69777799 });
  });

  it("returns no-docket for text with no docket reference", () => {
    expect(parseMention("@ape.rcape.org hello there")).toEqual({
      kind: "no-docket",
    });
  });

  it("prefers a link-facet URL over truncated display text", () => {
    // Bluesky truncates long URLs in the visible post text (".../docket/71795...")
    // but the link facet preserves the full URL — parse the facet, not the text.
    expect(
      parseMention(
        "@ape.rcape.org give me www.courtlistener.com/docket/71795... please",
        [
          "https://www.courtlistener.com/docket/71795960/united-states-v-rabbitt/",
        ],
      ),
    ).toEqual({ docketId: 71795960 });
  });

  it("falls back to text parsing when no link facet carries a docket", () => {
    expect(
      parseMention("@ape.rcape.org docket 69777799 please", [
        "https://example.com/not-a-docket",
      ]),
    ).toEqual({ docketId: 69777799 });
  });
});
