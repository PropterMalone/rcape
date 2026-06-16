import { describe, expect, it } from "vitest";
import {
  parseCaseNumber,
  parseCaseRef,
  parseCourt,
  parseDocketId,
  parseDocketLink,
  parseMention,
} from "./mention.js";

describe("parseCaseNumber", () => {
  it("extracts a civil case number", () => {
    expect(parseCaseNumber("can you pull 3:26-cv-05763")).toBe("3:26-cv-05763");
  });

  it("extracts a criminal case number and drops the judge-initial suffix", () => {
    expect(parseCaseNumber("CASE 0:26-cr-00115-KMM-DTS")).toBe("0:26-cr-00115");
  });

  it("handles a 3-letter type code (md) and 1-digit office", () => {
    expect(parseCaseNumber("the 1:24-md-03101 MDL")).toBe("1:24-md-03101");
  });

  it("lowercases the type code", () => {
    expect(parseCaseNumber("0:26-CR-00115")).toBe("0:26-cr-00115");
  });

  it("returns null when no case number is present", () => {
    expect(parseCaseNumber("@ape please add the Anthropic case")).toBeNull();
    // a bare CL docket id is NOT a case number
    expect(parseCaseNumber("docket 73482575")).toBeNull();
  });
});

describe("parseCourt", () => {
  it("resolves a bankruptcy court from its Bluebook abbreviation", () => {
    expect(
      parseCourt("Rollcage Technology, Inc., 22-20743, (Bankr. D. Conn.)"),
    ).toBe("ctb");
  });

  it("prefers the longest (most specific) matching label", () => {
    // "Bankr. D. Conn." contains "D. Conn." as a token run; the longer label wins.
    expect(parseCourt("(Bankr. D. Conn.)")).toBe("ctb");
    expect(parseCourt("filed in D. Conn.")).toBe("ctd");
  });

  it("resolves a district court written with dotted initials", () => {
    expect(parseCourt("a case in S.D.N.Y. today")).toBe("nysd");
  });

  it("returns null when no court is named", () => {
    expect(parseCourt("@ape please add this one")).toBeNull();
  });

  it("ignores single-token labels so prose words can't false-match a court", () => {
    // "bia" is a single-token label (BIA); a bare word must not resolve a court.
    expect(parseCourt("the bia ruling was wild")).toBeNull();
  });
});

describe("parseCaseRef", () => {
  it("parses a bankruptcy citation into number + court", () => {
    expect(
      parseCaseRef("Rollcage Technology, Inc., 22-20743, (Bankr. D. Conn.)"),
    ).toEqual({ caseNumber: "22-20743", courtId: "ctb" });
  });

  it("passes a district case number through unscoped (courtId null)", () => {
    expect(parseCaseRef("can you pull 3:26-cv-05763")).toEqual({
      caseNumber: "3:26-cv-05763",
      courtId: null,
    });
  });

  it("rejects a bare bankruptcy-shaped number with no court (false-positive guard)", () => {
    expect(parseCaseRef("the 22-20743 thing")).toBeNull();
  });

  it("strips a trailing judge/division suffix on a bankruptcy number", () => {
    expect(parseCaseRef("22-20743-jjt in Bankr. D. Conn.")).toEqual({
      caseNumber: "22-20743",
      courtId: "ctb",
    });
  });

  it("matches an adversary-proceeding number with a court", () => {
    expect(parseCaseRef("adv. 22-02014, Bankr. D. Conn.")).toEqual({
      caseNumber: "22-02014",
      courtId: "ctb",
    });
  });

  it("returns null when there is neither a case number nor a court", () => {
    expect(parseCaseRef("@ape please add the Anthropic case")).toBeNull();
  });
});

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

describe("parseDocketLink", () => {
  it("extracts a docket id from a /docket/ URL in the text", () => {
    expect(
      parseDocketLink(
        "see https://www.courtlistener.com/docket/69777799/x/ here",
      ),
    ).toEqual({ docketId: 69777799 });
  });

  it("prefers a link-facet URL over truncated display text", () => {
    expect(
      parseDocketLink("give me www.courtlistener.com/docket/71795... please", [
        "https://www.courtlistener.com/docket/71795960/united-states-v-rabbitt/",
      ]),
    ).toEqual({ docketId: 71795960 });
  });

  it("does NOT match a bare keyword+number — links only, unlike parseMention", () => {
    // The bare-7-digit heuristic is mention-only; on arbitrary thread posts it is
    // a false-positive magnet (a wrong guess burns ~17 CL calls).
    expect(parseDocketLink("@ape.rcape.org add case 1234567")).toBeNull();
    expect(parseDocketLink("docket 69777799 please")).toBeNull();
  });

  it("returns null for an out-of-range docket id in a URL", () => {
    expect(parseDocketLink("/docket/10000000000/x/")).toBeNull();
  });

  it("returns null when no docket link is present", () => {
    expect(
      parseDocketLink("hello there", ["https://example.com/foo"]),
    ).toBeNull();
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
