import { describe, expect, it } from "vitest";
import {
  type ThreadView,
  collectThreadPosts,
  scanThreadForDocket,
} from "./thread.js";

// Fixture builders mirroring the @atproto/api ThreadViewPost slice thread.ts
// consumes: a post's link facets carry the full (untruncated) URL, and a quoted
// post is an `app.bsky.embed.record#view` embed with the record at .record.value.
const linkFacet = (uri: string) => ({
  features: [{ $type: "app.bsky.richtext.facet#link", uri }],
});
const rec = (text: string, links: string[] = []) => ({
  text,
  facets: links.map(linkFacet),
});
const quote = (text: string, links: string[] = []) => ({
  $type: "app.bsky.embed.record#view",
  record: { value: rec(text, links) },
});
// A post carrying an external link card (news article / docket story): the URL +
// the card's headline live in app.bsky.embed.external, NOT in a #link facet.
const card = (
  text: string,
  uri: string,
  title?: string,
  description?: string,
) => ({
  text,
  embed: {
    $type: "app.bsky.embed.external",
    external: { uri, title, description },
  },
});
const docket = (id: number) =>
  `https://www.courtlistener.com/docket/${id}/some-case/`;

describe("scanThreadForDocket", () => {
  it("finds a docket link in the immediate parent", () => {
    const thread: ThreadView = {
      post: { record: rec("@ape.rcape.org add this one") },
      parent: { post: { record: rec("filed today", [docket(69777799)]) } },
    };
    expect(scanThreadForDocket(thread)).toEqual({ docketId: 69777799 });
  });

  it("returns the NEAREST parent's docket when several ancestors carry one", () => {
    const thread: ThreadView = {
      post: { record: rec("@ape add") },
      parent: {
        post: { record: rec("near", [docket(1111111)]) },
        parent: { post: { record: rec("far", [docket(2222222)]) } },
      },
    };
    expect(scanThreadForDocket(thread)).toEqual({ docketId: 1111111 });
  });

  it("finds a docket in the mention's quoted post, ahead of any parent", () => {
    const thread: ThreadView = {
      post: {
        record: rec("@ape add this"),
        embed: quote("US v. X", [docket(3333333)]),
      },
      parent: { post: { record: rec("parent", [docket(4444444)]) } },
    };
    expect(scanThreadForDocket(thread)).toEqual({ docketId: 3333333 });
  });

  it("finds a docket in a quoted post on a top-level mention (no parents)", () => {
    const thread: ThreadView = {
      post: {
        record: rec("@ape add this"),
        embed: quote("US v. X", [docket(5555555)]),
      },
    };
    expect(scanThreadForDocket(thread)).toEqual({ docketId: 5555555 });
  });

  it("stops at a notFound parent — cannot see above a deleted post", () => {
    const thread: ThreadView = {
      post: { record: rec("@ape add") },
      parent: { notFound: true },
    };
    expect(scanThreadForDocket(thread)).toBeNull();
  });

  it("stops at a blocked parent", () => {
    const thread: ThreadView = {
      post: { record: rec("@ape add") },
      parent: { blocked: true },
    };
    expect(scanThreadForDocket(thread)).toBeNull();
  });

  it("links-only: a bare keyword+number in an ancestor must NOT match", () => {
    // The bare-7-digit heuristic is mention-only; a stray number in someone
    // else's ancestor post isn't a docket request and would burn ~17 CL calls.
    const thread: ThreadView = {
      post: { record: rec("@ape add") },
      parent: { post: { record: rec("please add case 1234567 sometime") } },
    };
    expect(scanThreadForDocket(thread)).toBeNull();
  });

  it("returns null when no post in the thread carries a docket link", () => {
    const thread: ThreadView = {
      post: { record: rec("@ape add") },
      parent: { post: { record: rec("just chatting here") } },
    };
    expect(scanThreadForDocket(thread)).toBeNull();
  });

  it("tolerates an absent or empty thread", () => {
    expect(scanThreadForDocket(undefined)).toBeNull();
    expect(scanThreadForDocket({})).toBeNull();
  });
});

describe("collectThreadPosts", () => {
  it("orders entries: mention's quote first, then ancestors nearest-first", () => {
    const thread: ThreadView = {
      post: { record: rec("the mention text"), embed: quote("Q") },
      parent: {
        post: { record: rec("P1") },
        parent: { post: { record: rec("P2") } },
      },
    };
    // The mention's own text ("the mention text") is excluded — the caller
    // (parseMention) already parsed it.
    expect(collectThreadPosts(thread).map((e) => e.text)).toEqual([
      "Q",
      "P1",
      "P2",
    ]);
  });

  it("includes an ancestor's own quoted post inline after the ancestor", () => {
    const thread: ThreadView = {
      post: { record: rec("@ape add") },
      parent: { post: { record: rec("P1"), embed: quote("P1-quote") } },
    };
    expect(collectThreadPosts(thread).map((e) => e.text)).toEqual([
      "P1",
      "P1-quote",
    ]);
  });

  it("folds an ancestor's link-card title/description into its entry text + URL", () => {
    const thread: ThreadView = {
      post: { record: rec("@ape can you pull this one?") },
      parent: {
        post: {
          record: card(
            "Exclusive:",
            "https://on.wsj.com/49YL2El",
            "Anthropic Sued Over Limits",
            "A consumer alleges the plan was oversold.",
          ),
        },
      },
    };
    const entries = collectThreadPosts(thread);
    expect(entries[0]?.text).toBe(
      "Exclusive: — Anthropic Sued Over Limits — A consumer alleges the plan was oversold.",
    );
    expect(entries[0]?.links).toEqual(["https://on.wsj.com/49YL2El"]);
  });

  it("finds a docket shared as a link card (URL is in the embed, not a facet)", () => {
    const thread: ThreadView = {
      post: { record: rec("@ape add") },
      parent: { post: { record: card("filed", docket(69777799), "US v. X") } },
    };
    expect(scanThreadForDocket(thread)).toEqual({ docketId: 69777799 });
  });
});
