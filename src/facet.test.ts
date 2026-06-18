import { describe, expect, it } from "vitest";
import {
  extractExternalEmbed,
  extractLinkFacets,
  extractPostLinks,
  linkFacets,
  mentionFacets,
  postTextWithCard,
} from "./facet.js";

const externalCard = (
  uri: string,
  title?: string,
  description?: string,
  text = "",
) => ({
  text,
  embed: {
    $type: "app.bsky.embed.external",
    external: { uri, title, description },
  },
});

describe("linkFacets", () => {
  it("emits a #link facet per http(s) URL with UTF-8 byte offsets", () => {
    const text = "see https://example.com/a and https://example.com/b";
    const facets = linkFacets(text);
    expect(facets).toHaveLength(2);
    expect(facets[0]?.features[0]?.uri).toBe("https://example.com/a");
    // byteStart of the first URL = byte length of "see "
    expect(facets[0]?.index.byteStart).toBe(4);
    expect(facets[0]?.index.byteEnd).toBe(4 + "https://example.com/a".length);
  });

  it("shifts offsets for a multibyte char before the URL", () => {
    const text = "→ https://example.com/x"; // "→" is 3 UTF-8 bytes
    const f = linkFacets(text)[0];
    expect(f?.index.byteStart).toBe(Buffer.byteLength("→ ", "utf8"));
  });

  it("excludes trailing sentence punctuation from the link", () => {
    const f = linkFacets("go to https://example.com/p.")[0];
    expect(f?.features[0]?.uri).toBe("https://example.com/p");
  });

  it("returns no facets when there's no URL", () => {
    expect(linkFacets("no links here")).toEqual([]);
  });
});

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

describe("extractExternalEmbed", () => {
  it("pulls the URL + title + description from a link card", () => {
    expect(
      extractExternalEmbed(
        externalCard("https://on.wsj.com/x", "Anthropic Sued", "summary"),
      ),
    ).toEqual({
      uri: "https://on.wsj.com/x",
      title: "Anthropic Sued",
      description: "summary",
    });
  });

  it("returns undefined for a non-external embed (e.g. a quote) or no embed", () => {
    expect(extractExternalEmbed({})).toBeUndefined();
    expect(
      extractExternalEmbed({ embed: { $type: "app.bsky.embed.record#view" } }),
    ).toBeUndefined();
  });
});

describe("extractPostLinks", () => {
  it("appends the link-card URL to the #link facet URLs", () => {
    const record = {
      facets: [
        {
          features: [
            {
              $type: "app.bsky.richtext.facet#link",
              uri: "https://a.example/",
            },
          ],
        },
      ],
      embed: {
        $type: "app.bsky.embed.external",
        external: { uri: "https://card.example/" },
      },
    };
    expect(extractPostLinks(record)).toEqual([
      "https://a.example/",
      "https://card.example/",
    ]);
  });

  it("does not duplicate a card URL already present as a facet", () => {
    const record = {
      facets: [
        {
          features: [
            {
              $type: "app.bsky.richtext.facet#link",
              uri: "https://x.example/",
            },
          ],
        },
      ],
      embed: {
        $type: "app.bsky.embed.external",
        external: { uri: "https://x.example/" },
      },
    };
    expect(extractPostLinks(record)).toEqual(["https://x.example/"]);
  });
});

describe("postTextWithCard", () => {
  it("joins post text with the card title + description", () => {
    expect(
      postTextWithCard(externalCard("u", "Title", "Desc", "comment")),
    ).toBe("comment — Title — Desc");
  });

  it("falls back to bare text when there's no card", () => {
    expect(postTextWithCard({ text: "just text" })).toBe("just text");
    expect(postTextWithCard({})).toBe("");
  });
});
