import { describe, expect, it } from "vitest";
import { buildCaseCard, caseProfileUrl } from "./card.js";

describe("buildCaseCard", () => {
  it("builds an external embed pointing at the case profile", () => {
    const c = buildCaseCard({
      handle: "doe-v-roe.rcape.org",
      caseName: "Doe v. Roe",
      docketNumber: "1:23-cv-04567",
      courtName: "S.D.N.Y.",
      filings: 42,
    });
    expect(c.$type).toBe("app.bsky.embed.external");
    expect(c.external.uri).toBe("https://bsky.app/profile/doe-v-roe.rcape.org");
    expect(c.external.title).toBe("Doe v. Roe");
    expect(c.external.description).toBe(
      "1:23-cv-04567 · S.D.N.Y. · 42 filings",
    );
    expect(c.external.thumb).toBeUndefined();
  });

  it("attaches the thumb BlobRef when provided", () => {
    const thumb = { $type: "blob", ref: "x" };
    const c = buildCaseCard({ handle: "h", caseName: "C" }, thumb);
    expect(c.external.thumb).toBe(thumb);
  });

  it("singularizes a one-filing case and drops the thumb key when absent", () => {
    const c = buildCaseCard({ handle: "h", caseName: "C", filings: 1 });
    expect(c.external.description).toBe("1 filing");
    expect("thumb" in c.external).toBe(false);
  });

  it("falls back gracefully when case facts are missing (old ledger entry)", () => {
    const c = buildCaseCard({ handle: "h.rcape.org" });
    expect(c.external.title).toBe("Court docket archive");
    expect(c.external.description).toBe(
      "U.S. federal court docket — archived by R.C. Ape",
    );
  });

  it("omits absent description parts (court only)", () => {
    const c = buildCaseCard({
      handle: "h",
      caseName: "C",
      courtName: "D. Conn.",
    });
    expect(c.external.description).toBe("D. Conn.");
  });

  it("caseProfileUrl builds the bsky.app profile link", () => {
    expect(caseProfileUrl("a.rcape.org")).toBe(
      "https://bsky.app/profile/a.rcape.org",
    );
  });
});
