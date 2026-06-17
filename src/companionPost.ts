// pattern: Functional Core
// Maps a docket entry to a companion app.bsky.feed.post so that following the
// case account in any standard Bluesky client surfaces new filings in-timeline.
// These are STAGED, not auto-published (outbound-message rule).

import type { DocketEntryRecord } from "./map.js";

// Official atproto automated-account tag — Bluesky renders the `bot` self-label.
export const BOT_SELF_LABEL = {
  $type: "com.atproto.label.defs#selfLabels",
  values: [{ val: "bot" }],
};

interface BskyExternalEmbed {
  $type: "app.bsky.embed.external";
  external: { uri: string; title: string; description: string };
}

interface BskyPost {
  $type: "app.bsky.feed.post";
  text: string;
  createdAt: string;
  embed?: BskyExternalEmbed;
  labels?: { $type: string; values: { val: string }[] };
}

const MAX_GRAPHEMES = 300;

const segmenter = new Intl.Segmenter();

/** Grapheme-aware truncation. Counts grapheme clusters, not code units. */
export function truncate(s: string, n: number): string {
  const t = s.trim();
  const segs = [...segmenter.segment(t)];
  if (segs.length <= n) return t;
  // trim trailing whitespace before appending ellipsis
  let end = n - 1;
  while (end > 0 && segs[end - 1]?.segment.trim() === "") end--;
  return `${segs
    .slice(0, end)
    .map((s) => s.segment)
    .join("")}…`;
}

// Backdated doc-posts must each get a UNIQUE, strictly-increasing createdAt.
// CourtListener stamps a docket entry's date_filed as a DATE (midnight), so every
// filing on a given day shares one timestamp — and Bluesky's AppView feed
// collapses posts that share a sort key to ONE per timestamp, hiding all but one
// filing per day even though every record exists on the PDS. Anchor each post at
// its filing date, bumping by 1s whenever that would collide with or precede the
// prior post: this keeps filing order and the displayed date (which derives from
// dateFiled separately) while making every sortAt distinct. `dateFileds` must be
// in publish order (the order fireBackfill iterates).
export function backdatedCreatedAts(dateFileds: readonly string[]): string[] {
  const STEP_MS = 1000;
  let prevMs = Number.NEGATIVE_INFINITY;
  return dateFileds.map((d) => {
    const base = Date.parse(d);
    const floor = prevMs + STEP_MS;
    const ms = Math.max(Number.isNaN(base) ? floor : base, floor);
    prevMs = ms;
    return new Date(ms).toISOString();
  });
}

// A filing renders one of two ways, so the timeline visibly distinguishes "the
// actual PDF is here" from "this entry has no document in RECAP":
//   📄 DOCUMENT — the RECAP scan is gathered (is_available); the card links to
//      the storage.courtlistener.com PDF and tags page count.
//   🗂 DOCKET ENTRY — text-only/un-gathered; the card links to the CourtListener
//      docket page and says "docket only".
// Gating the PDF link on isAvailable === true (not merely sourceUrl present) also
// avoids a dead link: a filepath can exist for a document CL hasn't gathered.
const DOC_ICON = "📄";
const DOCKET_ICON = "🗂";

export function entryToPost(
  entry: DocketEntryRecord,
  caseName: string,
  viewUrl: string,
  createdAt: string,
): BskyPost {
  const date = entry.dateFiled.slice(0, 10);
  const doc = entry.documents?.[0];
  const hasPdf = doc?.sourceUrl != null && doc.isAvailable === true;
  const icon = hasPdf ? DOC_ICON : DOCKET_ICON;

  const label = entry.entryNumber != null ? `Doc ${entry.entryNumber}: ` : "";
  const head = `${icon} ${caseName} — ${label}`;
  const tail = ` (${date})`;
  const body = truncate(
    entry.description,
    MAX_GRAPHEMES - head.length - tail.length,
  );
  const text = truncate(`${head}${body}${tail}`, MAX_GRAPHEMES);

  // Card title names the KIND ("Doc N" vs "Docket entry N"); the description
  // carries a type tag ("· N pp · PDF" vs "· docket only"). Together with the
  // card-footer domain (storage vs www), the two kinds read apart at a glance.
  const numLabel = entry.entryNumber != null ? ` ${entry.entryNumber}` : "";
  const cardTitle = hasPdf
    ? `${DOC_ICON} Doc${numLabel} · ${caseName}`
    : `${DOCKET_ICON} Docket entry${numLabel} · ${caseName}`;
  const typeTag = hasPdf
    ? doc?.pageCount
      ? ` · ${doc.pageCount} pp · PDF`
      : " · PDF"
    : " · docket only";
  const description = `${truncate(entry.description, 240)}${typeTag}`;

  return {
    $type: "app.bsky.feed.post",
    text,
    createdAt,
    embed: {
      $type: "app.bsky.embed.external",
      external: {
        uri: hasPdf && doc ? doc.sourceUrl : viewUrl,
        title: truncate(cardTitle, 120),
        description: truncate(description, 290),
      },
    },
    labels: BOT_SELF_LABEL,
  };
}
