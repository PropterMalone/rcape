import { describe, expect, it } from "vitest";
import {
  buildDirectoryMarkdown,
  buildPinnedPostText,
  listMembershipDiff,
} from "./directory.js";
import type { CaseEntry } from "./ledger.js";

const entry = (over: Partial<CaseEntry>): CaseEntry => ({
  did: "did:plc:x",
  handle: "x.rcape.org",
  password: "pw",
  createdAt: "2026-06-01T00:00:00.000Z",
  completed: true,
  ...over,
});

describe("buildDirectoryMarkdown", () => {
  it("renders only completed cases, newest-first, as a table", () => {
    const md = buildDirectoryMarkdown([
      entry({
        handle: "older.rcape.org",
        createdAt: "2026-06-01T00:00:00.000Z",
        caseName: "Older Case",
        courtName: "D.D.C.",
        docketNumber: "1:24-cv-1",
        filings: 3,
      }),
      entry({
        handle: "newer.rcape.org",
        createdAt: "2026-06-10T00:00:00.000Z",
        caseName: "Newer Case",
        courtName: "S.D.N.Y.",
        docketNumber: "1:25-cv-9",
        filings: 12,
      }),
      // an incomplete (crash-zombie) entry must be excluded
      entry({ handle: "pending.rcape.org", completed: false }),
    ]);
    const newerIdx = md.indexOf("Newer Case");
    const olderIdx = md.indexOf("Older Case");
    expect(newerIdx).toBeGreaterThan(-1);
    expect(olderIdx).toBeGreaterThan(-1);
    expect(newerIdx).toBeLessThan(olderIdx); // newest-first
    expect(md).not.toContain("pending.rcape.org"); // incomplete excluded
    // markdown table header present
    expect(md).toContain("| Case | Court | Docket # | Account | Filings |");
    // account cell links to the bsky profile
    expect(md).toContain(
      "[@newer.rcape.org](https://bsky.app/profile/newer.rcape.org)",
    );
    // a count line reflects the 2 completed cases
    expect(md).toMatch(/\b2\b/);
  });

  it("escapes pipe characters in a case name so the table can't break", () => {
    const md = buildDirectoryMarkdown([
      entry({ caseName: "A | B Corp", handle: "ab.rcape.org" }),
    ]);
    expect(md).toContain("A \\| B Corp");
    expect(md).not.toContain("| A | B Corp |"); // raw pipe would add a column
  });

  it("falls back to an em dash for fields missing on pre-card entries", () => {
    const md = buildDirectoryMarkdown([
      entry({
        handle: "bare.rcape.org",
        caseName: undefined,
        courtName: undefined,
        docketNumber: undefined,
        filings: undefined,
      }),
    ]);
    // the row still renders with the handle; absent fields show "—"
    expect(md).toContain(
      "[@bare.rcape.org](https://bsky.app/profile/bare.rcape.org)",
    );
    expect(md).toContain("—");
  });

  it("returns a non-empty header even with zero completed cases", () => {
    const md = buildDirectoryMarkdown([]);
    expect(md).toContain("R.C. Ape"); // title still present
    expect(md).toContain("| Case | Court | Docket # | Account | Filings |");
  });
});

describe("listMembershipDiff", () => {
  it("returns completed DIDs not already in the list, order preserved", () => {
    const diff = listMembershipDiff(
      ["did:a", "did:b", "did:c"],
      new Set(["did:b"]),
    );
    expect(diff).toEqual(["did:a", "did:c"]);
  });

  it("returns empty when every case is already listed", () => {
    expect(listMembershipDiff(["did:a"], new Set(["did:a", "did:b"]))).toEqual(
      [],
    );
  });

  it("dedupes repeated DIDs in the input", () => {
    expect(listMembershipDiff(["did:a", "did:a"], new Set())).toEqual([
      "did:a",
    ]);
  });
});

describe("buildPinnedPostText", () => {
  it("links both the how-it-works and the shelf gist", () => {
    const text = buildPinnedPostText(
      "https://gist.github.com/PropterMalone/SHELF",
    );
    expect(text).toContain("https://gist.github.com/PropterMalone/SHELF");
    // keeps the existing how-it-works gist link
    expect(text).toContain("579b9d77577fe45c3cb540905ba7d6ec");
  });
});
