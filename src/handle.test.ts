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
    expect(deriveHandle("Abrego Garcia v. Noem", "8:25-cv-00951", "rcape.org")).toBe(
      "abrego-garcia.rcape.org",
    );
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

  it("caps the slug length and never ends in a hyphen", () => {
    const h = deriveHandle(
      "The Exceptionally Verbose Plaintiff Coalition Of Many Words Indeed",
      "1:24-cv-9",
      "rcape.org",
    );
    const slug = h.slice(0, h.indexOf("."));
    expect(slug.length).toBeLessThanOrEqual(30);
    expect(slug.endsWith("-")).toBe(false);
    expect(slug).toBe("the-exceptionally-verbose-plai");
  });

  it("disambiguates collisions with a numeric suffix", () => {
    const taken = new Set(["smith.rcape.org", "smith-2.rcape.org"]);
    expect(deriveHandle("Smith v. Co", "1:24-cv-3", "rcape.org", taken)).toBe(
      "smith-3.rcape.org",
    );
  });

  it("keeps the suffixed slug under the cap by trimming the base", () => {
    const base = "a".repeat(30);
    const taken = new Set([`${base}.rcape.org`]);
    const h = deriveHandle(base, "1:24-cv-4", "rcape.org", taken);
    const slug = h.slice(0, h.indexOf("."));
    expect(slug.length).toBeLessThanOrEqual(30);
    expect(slug).toBe(`${"a".repeat(28)}-2`);
  });
});
