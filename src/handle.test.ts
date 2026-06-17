import { describe, expect, it } from "vitest";
import { deriveHandle, slugify } from "./handle.js";

describe("slugify", () => {
  it("lowercases, strips punctuation, hyphenates", () => {
    expect(slugify("Abrego Garcia")).toBe("abrego-garcia");
  });

  it("strips diacritics", () => {
    expect(slugify("José Núñez")).toBe("jose-nunez");
  });

  it("collapses runs and trims edge hyphens", () => {
    expect(slugify("  In re:  Foo — Bar!! ")).toBe("in-re-foo-bar");
  });

  it("returns empty for all-punctuation input", () => {
    expect(slugify("!!!???")).toBe("");
  });
});

describe("deriveHandle", () => {
  it("uses the plaintiff (pre-'v.') and matches the live handle", () => {
    expect(
      deriveHandle("Abrego Garcia v. Noem", "8:25-cv-00951", "rcape.org"),
    ).toBe("abrego-garcia.rcape.org");
  });

  it("handles ' vs ' and ' v ' separators", () => {
    expect(deriveHandle("Smith vs Jones", "1:24-cv-1", "rcape.org")).toBe(
      "smith.rcape.org",
    );
    expect(deriveHandle("Doe v Roe", "1:24-cv-2", "rcape.org")).toBe(
      "doe.rcape.org",
    );
  });

  it("falls back to the docket number when the name yields no slug", () => {
    expect(deriveHandle("!!!", "1:24-cv-12345", "rcape.org")).toBe(
      "case-1-24-cv-12345.rcape.org",
    );
  });

  it("caps the slug at the PDS 18-char label limit and never ends in a hyphen", () => {
    const h = deriveHandle(
      "The Exceptionally Verbose Plaintiff Coalition Of Many Words Indeed",
      "1:24-cv-9",
      "rcape.org",
    );
    const slug = h.slice(0, h.indexOf("."));
    expect(slug.length).toBeLessThanOrEqual(18);
    expect(slug.endsWith("-")).toBe(false);
    expect(slug).toBe("the-exceptionally"); // 18-char cut lands on a hyphen → trimmed
  });

  it("never exceeds the PDS 18-char label limit, even for very long case names", () => {
    // The exact bug: Johnson & Johnson… produced a 30-char label → PDS 400
    // "Handle too long". The label (before .rcape.org) must be ≤18.
    const h = deriveHandle(
      "JOHNSON & JOHNSON HEALTH CARE SYSTEMS INC. v. SAVE ON SP, LLC",
      "2:22-cv-02632",
      "rcape.org",
    );
    const label = h.slice(0, h.indexOf("."));
    expect(label.length).toBeLessThanOrEqual(18);
    expect(label.endsWith("-")).toBe(false);
    expect(h.endsWith(".rcape.org")).toBe(true);
  });

  it("derives from the defendant when the plaintiff is the government (criminal cases)", () => {
    // Every federal criminal case is "United States v. <defendant>", so deriving
    // from the plaintiff collides them all onto "united-states".
    expect(
      deriveHandle("United States v. Rabbitt", "1:25-cr-00693", "rcape.org"),
    ).toBe("rabbitt.rcape.org");
    expect(deriveHandle("USA v. Smith", "1:24-cr-1", "rcape.org")).toBe(
      "smith.rcape.org",
    );
    expect(
      deriveHandle(
        "United States of America v. Jones",
        "1:24-cr-2",
        "rcape.org",
      ),
    ).toBe("jones.rcape.org");
  });

  it("still uses the plaintiff for a civil party that merely contains 'United States'", () => {
    // "United States Steel Corp" is a party, not the prosecuting government —
    // the anchored match avoids that false positive.
    expect(
      deriveHandle(
        "United States Steel Corp v. Acme",
        "1:24-cv-9",
        "rcape.org",
      ),
    ).toBe("united-states-stee.rcape.org"); // plaintiff used, capped at 18
  });

  it("disambiguates collisions with a numeric suffix", () => {
    const taken = new Set(["smith.rcape.org", "smith-2.rcape.org"]);
    expect(deriveHandle("Smith v. Co", "1:24-cv-3", "rcape.org", taken)).toBe(
      "smith-3.rcape.org",
    );
  });

  it("keeps the suffixed slug under the 18-char cap by trimming the base", () => {
    const base = "a".repeat(18); // already at the cap
    const taken = new Set([`${base}.rcape.org`]);
    const h = deriveHandle(base, "1:24-cv-4", "rcape.org", taken);
    const slug = h.slice(0, h.indexOf("."));
    expect(slug.length).toBeLessThanOrEqual(18);
    expect(slug).toBe(`${"a".repeat(16)}-2`); // base trimmed to fit "-2"
  });
});
