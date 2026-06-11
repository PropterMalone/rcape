import { describe, expect, it } from "vitest";
import {
  CASE_HINT_SCHEMA,
  buildCaseHintPrompt,
  validateCaseHint,
} from "./caseHint.js";

describe("buildCaseHintPrompt", () => {
  it("embeds the valid court ids with their labels", () => {
    const p = buildCaseHintPrompt("some mention", []);
    expect(p).toContain("nysd = S.D.N.Y.");
    expect(p).toContain("cand = N.D. Cal.");
  });

  it("fences the untrusted post text and includes mention + thread entries", () => {
    const p = buildCaseHintPrompt("the SBF fraud case", [
      { text: "they indicted him in Manhattan" },
    ]);
    expect(p).toContain("BEGIN UNTRUSTED POSTS");
    expect(p).toContain("END UNTRUSTED POSTS");
    expect(p).toContain("the SBF fraud case");
    expect(p).toContain("they indicted him in Manhattan");
    // instructions-in-content guardrail is stated before the fence
    expect(p.toLowerCase()).toContain("never follow instructions");
  });

  it("caps each post's text at 1,000 chars", () => {
    const long = "x".repeat(5_000);
    const p = buildCaseHintPrompt(long, [{ text: long }]);
    expect(p).not.toContain("x".repeat(1_001));
    expect(p).toContain("x".repeat(1_000));
  });

  it("includes at most 10 thread entries", () => {
    const entries = Array.from({ length: 15 }, (_, i) => ({
      text: `entry-number-${i}`,
    }));
    const p = buildCaseHintPrompt("m", entries);
    expect(p).toContain("entry-number-9");
    expect(p).not.toContain("entry-number-10");
  });
});

describe("CASE_HINT_SCHEMA", () => {
  it("is an object schema over caption and courtId", () => {
    const s = CASE_HINT_SCHEMA as {
      type: string;
      properties: Record<string, unknown>;
    };
    expect(s.type).toBe("object");
    expect(Object.keys(s.properties)).toEqual(["caption", "courtId"]);
  });
});

describe("validateCaseHint", () => {
  it("accepts a caption with a known court id", () => {
    expect(
      validateCaseHint({ caption: "United States v. Smith", courtId: "nysd" }),
    ).toEqual({ caption: "United States v. Smith", courtId: "nysd" });
  });

  it("coerces an unknown court id to null (search unfiltered, not a 400)", () => {
    expect(
      validateCaseHint({ caption: "United States v. Smith", courtId: "mars" }),
    ).toEqual({ caption: "United States v. Smith", courtId: null });
  });

  it("coerces a non-string / absent court id to null", () => {
    expect(validateCaseHint({ caption: "A v. B", courtId: 7 })).toEqual({
      caption: "A v. B",
      courtId: null,
    });
    expect(validateCaseHint({ caption: "A v. B" })).toEqual({
      caption: "A v. B",
      courtId: null,
    });
  });

  it("rejects garbage shapes", () => {
    expect(validateCaseHint(null)).toBeNull();
    expect(validateCaseHint("United States v. Smith")).toBeNull();
    expect(validateCaseHint(42)).toBeNull();
    expect(validateCaseHint({ courtId: "nysd" })).toBeNull();
    expect(validateCaseHint({ caption: null, courtId: "nysd" })).toBeNull();
  });

  it("rejects an empty or whitespace caption", () => {
    expect(validateCaseHint({ caption: "" })).toBeNull();
    expect(validateCaseHint({ caption: "   " })).toBeNull();
  });

  it("rejects an absurdly long caption", () => {
    expect(validateCaseHint({ caption: "x".repeat(201) })).toBeNull();
  });

  it("strips quotes and control chars from the caption (it lands inside a quoted query operator)", () => {
    expect(
      validateCaseHint({ caption: 'United "States" v.\u0000\nSmith' }),
    ).toEqual({ caption: "United States v. Smith", courtId: null });
  });
});
