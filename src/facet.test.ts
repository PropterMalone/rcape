import { describe, expect, it } from "vitest";
import { extractLinkFacets, mentionFacets } from "./facet.js";

// The UTF-8 byte length of a string, the unit AT Protocol facets index in.
const bytes = (s: string): number => Buffer.byteLength(s, "utf8");

describe("mentionFacets", () => {
  it("indexes byteStart/byteEnd in UTF-8 bytes, not chars, before a multibyte handle", () => {
    // "Ook…" — the ellipsis (…) is 3 UTF-8 bytes but a single JS char, so a
    // char-offset implementation would point the facet 2 bytes too early.
    const text = "Ook… now at @case.rcape.org — browse it.";
    const facets = mentionFacets(text, { "case.rcape.org": "did:case" });

    expect(facets).toHaveLength(1);
    const f = facets[0];
    const handle = "@case.rcape.org";
    const before = text.slice(0, text.indexOf(handle));
    expect(f?.index.byteStart).toBe(bytes(before));
    expect(f?.index.byteEnd).toBe(bytes(before) + bytes(handle));
    // Slicing the original UTF-8 buffer at those offsets recovers the handle.
    const buf = Buffer.from(text, "utf8");
    expect(
      buf.subarray(f?.index.byteStart, f?.index.byteEnd).toString("utf8"),
    ).toBe(handle);
    expect(f?.features[0]?.$type).toBe("app.bsky.richtext.facet#mention");
    expect(f?.features[0]?.did).toBe("did:case");
  });

  it("emits a facet for every occurrence of a known handle (e.g. @proptermalone twice)", () => {
    const text =
      "@proptermalone follows, or who follow @proptermalone. Ask there.";
    const facets = mentionFacets(text, { proptermalone: "did:owner" });
    expect(facets).toHaveLength(2);
    for (const f of facets) {
      expect(f.features[0]?.did).toBe("did:owner");
      const buf = Buffer.from(text, "utf8");
      expect(
        buf.subarray(f.index.byteStart, f.index.byteEnd).toString("utf8"),
      ).toBe("@proptermalone");
    }
  });

  it("does not match a longer handle when only a prefix is known", () => {
    // Known handle "case" must not match inside "@case.rcape.org" as a prefix —
    // the next char after the handle must be a non-handle char (or end).
    const text = "see @case.rcape.org";
    const facets = mentionFacets(text, { case: "did:short" });
    expect(facets).toEqual([]);
  });

  it("returns [] when the text carries no known handle", () => {
    expect(
      mentionFacets("Ook. No docket here.", { "x.rcape.org": "did:x" }),
    ).toEqual([]);
  });
});

describe("extractLinkFacets", () => {
  it("returns the full URL from a #link facet (not the truncated text)", () => {
    const record = {
      facets: [
        {
          features: [
            {
              $type: "app.bsky.richtext.facet#link",
              uri: "https://www.courtlistener.com/docket/71795960/x/",
            },
          ],
        },
      ],
    };
    expect(extractLinkFacets(record)).toEqual([
      "https://www.courtlistener.com/docket/71795960/x/",
    ]);
  });

  it("ignores non-link facets (e.g. mentions) and keeps only link URIs", () => {
    const record = {
      facets: [
        {
          features: [
            { $type: "app.bsky.richtext.facet#mention", did: "did:someone" },
            {
              $type: "app.bsky.richtext.facet#link",
              uri: "https://a.example/",
            },
          ],
        },
        {
          features: [
            {
              $type: "app.bsky.richtext.facet#link",
              uri: "https://b.example/",
            },
          ],
        },
      ],
    };
    expect(extractLinkFacets(record)).toEqual([
      "https://a.example/",
      "https://b.example/",
    ]);
  });

  it("returns [] for a record with no facets", () => {
    expect(extractLinkFacets({})).toEqual([]);
    expect(extractLinkFacets({ facets: [] })).toEqual([]);
  });
});
