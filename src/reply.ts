// pattern: Functional Core
// Builds the bot's reply text for each outcome, in the dignified Pratchett-
// Librarian register. Pure: no I/O. Case names are clamped so the payload (the
// new @handle) always survives the 300-grapheme post limit. Failure-to-find
// replies carry a clickable CourtListener search link (a #link facet over a
// shortened display span — the full prefilled-query URL would blow the
// grapheme budget as text).

import { graphemeLen, truncate } from "./companionPost.js";
import type { LinkFacet } from "./facet.js";

const MAX_POST = 300;
const NAME_BUDGET = 80;

// The owner's display handle as it appears in copy (the "declined" reply). The
// facet builder matches this exact substring to attach the owner's mention
// facet, so copy and facet map stay in sync. (Bare, not the full bsky handle —
// it renders short; the facet's `did` is what makes it resolve + notify.)
export const OWNER_DISPLAY_HANDLE = "proptermalone";

const CL_BASE = "https://www.courtlistener.com";
// The visible link span is clamped hard: it's display text only (the facet
// carries the full URI), and an unbounded encoded caption would eat the body's
// grapheme budget.
const LINK_DISPLAY_MAX = 40;
const LINK_LEAD = "\n\n🔎 ";

export interface BuiltReply {
  text: string;
  // #link facets for the search link, with byte offsets valid for `text`.
  // Callers merge these with the mention facets they compute over the text.
  facets: LinkFacet[];
}

export type ReplyKind =
  // ack/queued fire at mention time, before any CL fetch — only the docket id
  // is known then (the case name costs a quota call we haven't spent yet).
  | { kind: "ack"; docketId: number }
  | { kind: "queued"; docketId: number; ahead: number }
  // `failed` is the count of filings whose backdated doc-post failed during
  // backfill (0 on a clean run). Surfaced so the requester knows the archive is
  // partial — those entries exist as records but have no companion post yet.
  | { kind: "provisioned"; caseName: string; handle: string; failed: number }
  // `checking` — a monitor re-check was forced for this case (the mention is a
  // freshness signal), so the copy can honestly promise fresh filings shortly.
  | { kind: "exists"; handle: string; checking?: boolean }
  // The requester is at their in-flight cap; their new docket wasn't queued.
  // docketId names the turned-away case so the reply isn't ambiguous when they
  // have several in flight.
  | { kind: "over-cap"; inFlight: number; docketId: number }
  | { kind: "declined" }
  | { kind: "no-docket" }
  // v1b: prose inference proposed a caption but the CourtListener search
  // didn't verify it as exactly one docket. matches is the search's count
  // (0 = no such case found, ≥2 = ambiguous).
  | { kind: "suggest"; caption: string; matches: number }
  | { kind: "not-found" }
  // Posted once when today's CourtListener budget runs out before a started
  // (acked) case could finish — so a large docket that exceeds the daily limit
  // mid-shelving doesn't leave the requester waiting on a "shelved" reply that
  // won't come until the next day's reset.
  | { kind: "deferred"; docketId: number }
  // Posted once when CourtListener's hourly rate window is closed mid-shelving —
  // distinct from `deferred` (daily cap): the hourly window reopens within the
  // day, so this promises "soon", not "tomorrow".
  | { kind: "throttled"; docketId: number }
  // Posted only after retries are exhausted, so the requester isn't left in
  // permanent silence after the ack.
  | { kind: "failed"; docketId: number };

// The CL search URL for a failure reply: prefilled RECAP search when we have a
// caption guess, the bare RECAP search page otherwise. The query caption is
// sliced (not truncate()d — a trailing "…" would pollute the search terms);
// URLSearchParams encodes spaces as "+" so typical captions stay short.
function searchUri(caption?: string): string {
  if (caption === undefined) return `${CL_BASE}/recap/`;
  const q = new URLSearchParams({
    q: caption.trim().slice(0, 100),
    type: "r",
  });
  return `${CL_BASE}/?${q}`;
}

// Append a clickable search link to a failure reply's body. The body is clamped
// so body + link fit MAX_POST together — truncating AFTER appending would chop
// the link, and a broken link is worse than a short body. The facet's byte
// range covers exactly the display span (UTF-8 bytes, per the richtext spec —
// the 🔎 and any multibyte body chars shift it past char offsets).
function withSearchLink(body: string, uri: string): BuiltReply {
  const display = truncate(
    uri.replace(/^https:\/\/www\./, ""),
    LINK_DISPLAY_MAX,
  );
  const tail = `${LINK_LEAD}${display}`;
  const text = `${truncate(body, MAX_POST - graphemeLen(tail))}${tail}`;
  const byteEnd = Buffer.byteLength(text, "utf8");
  const byteStart = byteEnd - Buffer.byteLength(display, "utf8");
  return {
    text,
    facets: [
      {
        index: { byteStart, byteEnd },
        features: [{ $type: "app.bsky.richtext.facet#link", uri }],
      },
    ],
  };
}

export function buildReply(r: ReplyKind): BuiltReply {
  let text: string;
  switch (r.kind) {
    case "ack":
      text = `Ook. Fetching CourtListener docket ${r.docketId} into the stacks — I'll reply here once it's shelved.`;
      break;
    case "queued":
      // `ahead` is the current queue DEPTH (count of waiting cases), an estimate
      // of how many sit before this one — not a guaranteed position, since drain
      // order and the daily budget shift it. Phrased as "~N waiting" accordingly.
      text = `Ook. Docket ${r.docketId} is in the queue (~${r.ahead} ${r.ahead === 1 ? "case" : "cases"} waiting). I shelve cases as the daily archive budget allows; I'll reply here when it's done.`;
      break;
    case "provisioned": {
      // The @handle is the load-bearing payload; the partial-failure note is
      // appended after it so truncation drops the note before the handle.
      const partial =
        r.failed > 0
          ? ` (${r.failed} ${r.failed === 1 ? "filing" : "filings"} couldn't be posted yet — I'll have another go later.)`
          : "";
      text = `Ook. Shelved: ${truncate(r.caseName, NAME_BUDGET)} now lives at @${r.handle} — every filing, in order. Browse the docket or follow along.${partial}`;
      break;
    }
    case "exists":
      text = `Ook. Already in the stacks — that case is at @${r.handle}.${
        r.checking
          ? " Checking the stacks for fresh filings now — anything new posts there shortly."
          : ""
      }`;
      break;
    case "over-cap":
      text = `Ook. Docket ${r.docketId} will have to wait — you already have ${r.inFlight} requests in my queue. I'll work through those first; mention me again once they clear. One ape, many stacks.`;
      break;
    case "declined":
      // Give a concrete path to access, not a dead end: the allowlist is
      // @proptermalone's follows ∪ followers, so "follow and re-mention" works.
      text = `Ook. For now the Librarian admits only those @${OWNER_DISPLAY_HANDLE} follows, or who follow back. Follow @${OWNER_DISPLAY_HANDLE} and mention me again, and I'll fetch your case.`;
      break;
    case "no-docket":
      // Acknowledge the mention (the requester knows I heard them), then ask for
      // the missing docket — not a bare broadcast of instructions. "Reply with"
      // (not "mention me again") because a plain reply with a link now works.
      // The search link gives them somewhere to FIND that link.
      return withSearchLink(
        "Ook? I hear you, but I couldn't find a docket in that. Reply with a CourtListener docket — a link (courtlistener.com/docket/…) or its id — and I'll fetch the case. Search the stacks:",
        searchUri(),
      );
    case "suggest": {
      // The guessed caption shows the requester what the Librarian understood,
      // so a wrong guess is self-explanatory and the fix (a link) is obvious.
      // The appended link opens CL search prefilled with the guess, so finding
      // the right docket is one tap, not a fresh search.
      if (r.matches === 0) {
        text = `Ook? My best guess was “${truncate(r.caption, NAME_BUDGET)}”, but the stacks show no such docket. Reply with the CourtListener docket link and I'll fetch it. Search the stacks:`;
      } else if (r.matches === 1) {
        // Exactly one match, but it came from a name guess — a same-name docket
        // can be the wrong one (a Joe-Biden post → the Hunter-Biden-IRS case), so
        // confirm rather than shelve. Singular grammar, confirm framing.
        text = `Ook — I think you mean ${truncate(r.caption, NAME_BUDGET)}, but I won't shelve a case from a name guess. If that's the one, reply with its CourtListener link and I'll fetch it; if not, send the right link. Here's my search:`;
      } else {
        text = `Ook — did you mean ${truncate(r.caption, NAME_BUDGET)}? I found ${r.matches} dockets like that. Reply with the CourtListener link for yours and I'll fetch it. Here's my search:`;
      }
      return withSearchLink(text, searchUri(r.caption));
    }
    case "not-found":
      return withSearchLink(
        "Ook. No such docket in CourtListener's stacks. Double-check the id or link — or search the stacks:",
        searchUri(),
      );
    case "deferred":
      text = `Ook. I've reached today's CourtListener limit — docket ${r.docketId} is shelved in the queue and I'll finish it tomorrow.`;
      break;
    case "throttled":
      text = `Ook. CourtListener's stacks are busy (rate limit) — docket ${r.docketId} is in the queue and I'll shelve it as soon as the limit clears. Hang tight.`;
      break;
    case "failed":
      text = `Ook. I couldn't shelve docket ${r.docketId} — the stacks gave way after a few tries. Mention me again later and I'll have another go.`;
      break;
  }
  return { text: truncate(text, MAX_POST), facets: [] };
}
