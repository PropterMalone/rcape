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
  | { kind: "provisioned"; caseName: string; handle: string }
  | { kind: "exists"; handle: string }
  | { kind: "declined" }
  | { kind: "no-docket" }
  | { kind: "not-found" };

export function buildReply(r: ReplyKind): string {
  let text: string;
  switch (r.kind) {
    case "ack":
      text = `Ook. Fetching CourtListener docket ${r.docketId} into the stacks — I'll reply here once it's shelved.`;
      break;
    case "queued":
      text = `Ook. Docket ${r.docketId} is in the queue (~${r.ahead} ahead). I shelve cases as the daily archive budget allows; I'll reply here when it's done.`;
      break;
    case "provisioned":
      text = `Ook. Shelved: ${truncate(r.caseName, NAME_BUDGET)} now lives at @${r.handle} — every filing, in order. Browse the docket or follow along.`;
      break;
    case "exists":
      text = `Ook. Already in the stacks — that case is at @${r.handle}.`;
      break;
    case "declined":
      text = `Ook. For now the Librarian admits requests only from those @${OWNER_DISPLAY_HANDLE} follows, or who follow @${OWNER_DISPLAY_HANDLE}. Ask there for a card.`;
      break;
    case "no-docket":
      text =
        "Ook? Point me at a CourtListener docket — a link (courtlistener.com/docket/…) or its id — and I'll fetch the case.";
      break;
    case "not-found":
      text =
        "Ook. No such docket in CourtListener's stacks. Double-check the id or link?";
      break;
  }
  return truncate(text, MAX_POST);
}
