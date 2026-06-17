// pattern: Functional Core
// Builds the app.bsky.embed.external link card the bot attaches to a reply that
// hands back a provisioned case. Instead of a bare @handle, the requester sees a
// rich card: the case name (title), its court + docket number + filing count
// (description), the seal (thumb), linking to the case account's Bluesky profile.
// Pure — the thumb BlobRef is uploaded by the shell and passed in.

import { truncate } from "./companionPost.js";

export interface CaseCard {
  handle: string;
  caseName?: string;
  docketNumber?: string;
  courtName?: string;
  filings?: number;
}

export interface ExternalEmbed {
  $type: "app.bsky.embed.external";
  external: {
    uri: string;
    title: string;
    description: string;
    // BlobRef from agent.uploadBlob; opaque here (atproto type), omitted when
    // the seal upload was unavailable so the card still renders text-only.
    thumb?: unknown;
  };
}

const TITLE_MAX = 120;

// The case account's Bluesky profile — the landing a tap on the card should open.
// There is no per-case web page; the profile is where every filing shows up.
export function caseProfileUrl(handle: string): string {
  return `https://bsky.app/profile/${handle}`;
}

export function buildCaseCard(card: CaseCard, thumb?: unknown): ExternalEmbed {
  const bits: string[] = [];
  if (card.docketNumber) bits.push(card.docketNumber);
  if (card.courtName) bits.push(card.courtName);
  if (card.filings != null) {
    bits.push(`${card.filings} ${card.filings === 1 ? "filing" : "filings"}`);
  }
  const description =
    bits.join(" · ") || "U.S. federal court docket — archived by R.C. Ape";
  return {
    $type: "app.bsky.embed.external",
    external: {
      uri: caseProfileUrl(card.handle),
      title: truncate(
        card.caseName?.trim() || "Court docket archive",
        TITLE_MAX,
      ),
      description,
      ...(thumb ? { thumb } : {}),
    },
  };
}
