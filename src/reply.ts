// pattern: Functional Core
// Builds the bot's reply text for each outcome, in the dignified Pratchett-
// Librarian register. Pure: no I/O. Case names are clamped so the payload (the
// new @handle) always survives the 300-grapheme post limit.

import { truncate } from "./companionPost.js";

const MAX_POST = 300;
const NAME_BUDGET = 80;

// The owner's display handle as it appears in copy (the "declined" reply). The
// facet builder matches this exact substring to attach the owner's mention
// facet, so copy and facet map stay in sync. (Bare, not the full bsky handle —
// it renders short; the facet's `did` is what makes it resolve + notify.)
export const OWNER_DISPLAY_HANDLE = "proptermalone";

export type ReplyKind =
  // ack/queued fire at mention time, before any CL fetch — only the docket id
  // is known then (the case name costs a quota call we haven't spent yet).
  | { kind: "ack"; docketId: number }
  | { kind: "queued"; docketId: number; ahead: number }
  // `failed` is the count of filings whose backdated doc-post failed during
  // backfill (0 on a clean run). Surfaced so the requester knows the archive is
  // partial — those entries exist as records but have no companion post yet.
  | { kind: "provisioned"; caseName: string; handle: string; failed: number }
  | { kind: "exists"; handle: string }
  // The requester is at their in-flight cap; their new docket wasn't queued.
  | { kind: "over-cap"; inFlight: number }
  | { kind: "declined" }
  | { kind: "no-docket" }
  | { kind: "not-found" }
  // Posted only after retries are exhausted, so the requester isn't left in
  // permanent silence after the ack.
  | { kind: "failed"; docketId: number };

export function buildReply(r: ReplyKind): string {
  let text: string;
  switch (r.kind) {
    case "ack":
      text = `Ook. Fetching CourtListener docket ${r.docketId} into the stacks — I'll reply here once it's shelved.`;
      break;
    case "queued":
      text = `Ook. Docket ${r.docketId} is in the queue (~${r.ahead} ahead). I shelve cases as the daily archive budget allows; I'll reply here when it's done.`;
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
      text = `Ook. Already in the stacks — that case is at @${r.handle}.`;
      break;
    case "over-cap":
      text = `Ook. You already have ${r.inFlight} requests in my queue — I'll work through those first, then you can ask again. One ape, many stacks.`;
      break;
    case "declined":
      text = `Ook. For now the Librarian admits requests only from those @${OWNER_DISPLAY_HANDLE} follows, or who follow @${OWNER_DISPLAY_HANDLE}. Ask there for a card.`;
      break;
    case "no-docket":
      // Acknowledge the mention (the requester knows I heard them), then ask for
      // the missing docket — not a bare broadcast of instructions.
      text =
        "Ook? I hear you, but I couldn't find a docket in that. Point me at a CourtListener docket — a link (courtlistener.com/docket/…) or its id — and I'll fetch the case.";
      break;
    case "not-found":
      text =
        "Ook. No such docket in CourtListener's stacks. Double-check the id or link?";
      break;
    case "failed":
      text = `Ook. I couldn't shelve docket ${r.docketId} — the stacks gave way after a few tries. Mention me again later and I'll have another go.`;
      break;
  }
  return truncate(text, MAX_POST);
}
