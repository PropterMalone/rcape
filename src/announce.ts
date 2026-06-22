// pattern: Imperative Shell
// Announce-on-provision: when the bot mints a NEW case account, @ape.rcape.org
// posts a standalone skeet linking it, so the bot's own feed becomes a live stream
// of the growing archive. Fires for EVERY new provision (by-request and pre-shelve
// alike) — by-request cases also keep their threaded reply to the requester; this
// is the additional public announcement.
//
// CONSENT NOTE: the announcement references only the CASE (a public court record) —
// never the journalist whose post surfaced it. The pre-shelve harvest's `source`
// stays internal. This keeps the "do not mention them" invariant intact.

import type { BotAgent } from "./botAgent.js";
import { buildCaseCard } from "./card.js";
import { BOT_SELF_LABEL, truncate } from "./companionPost.js";
import { mentionFacets } from "./facet.js";

const POST = "app.bsky.feed.post";
// Cap the case name well under the 300-grapheme post limit so the full template
// (the "@handle" mention + suffix) always survives intact — truncating the whole
// composed string afterward could sever the @handle and break the mention facet's
// byte offsets. caseName is the only unbounded field; the rest is fixed + a handle.
const CASE_NAME_MAX = 180;

// The fields announceProvision needs from a "provisioned" ProvisionResult.
export interface ProvisionedAnnouncement {
  handle: string;
  did: string;
  caseName: string;
  docketNumber?: string;
  courtName?: string;
  published: number;
}

export interface AnnounceDeps {
  agent: Pick<BotAgent, "createRecord">;
  // Seal BlobRef for the card thumbnail (uploaded once at startup); absent ⇒ a
  // text-only card.
  cardThumb?: unknown;
  // Opt-out switch (RCAPE_ANNOUNCE_PROVISIONS). Default on; false disables.
  announce?: boolean;
}

// pattern: Functional Core
// The announcement copy: case name (capped) + docket number, then "@handle". The
// @handle appears verbatim so mentionFacets can turn it into a tappable mention
// that also notifies the (bot-owned) case account.
export function announcementText(p: ProvisionedAnnouncement): string {
  const name = truncate(p.caseName?.trim() || "Court docket", CASE_NAME_MAX);
  const docket = p.docketNumber ? ` (${p.docketNumber})` : "";
  return `🦍 New on the shelf: ${name}${docket}. Follow @${p.handle} for every filing as it lands.`;
}

// Post the standalone announcement. Best-effort: a post failure is logged and
// swallowed so it can never fail or abort the provision that triggered it. Skips
// entirely when announcements are disabled.
export async function announceProvision(
  deps: AnnounceDeps,
  p: ProvisionedAnnouncement,
): Promise<void> {
  if (deps.announce === false) return;
  try {
    const text = announcementText(p);
    await deps.agent.createRecord(POST, {
      $type: POST,
      text,
      createdAt: new Date().toISOString(),
      labels: BOT_SELF_LABEL,
      facets: mentionFacets(text, { [p.handle]: p.did }),
      embed: buildCaseCard(
        {
          handle: p.handle,
          caseName: p.caseName,
          docketNumber: p.docketNumber,
          courtName: p.courtName,
          filings: p.published,
        },
        deps.cardThumb,
      ),
    });
    console.log(`announce: posted new-case skeet for @${p.handle}`);
  } catch (e) {
    console.error(
      `announce: failed to post for @${p.handle}:`,
      e instanceof Error ? e.message : String(e),
    );
  }
}
