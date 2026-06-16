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

export function entryToPost(
  entry: DocketEntryRecord,
  caseName: string,
  viewUrl: string,
  createdAt: string,
): BskyPost {
  const date = entry.dateFiled.slice(0, 10);
  const label = entry.entryNumber != null ? `Doc ${entry.entryNumber}: ` : "";
  const head = `📄 ${caseName} — ${label}`;
  const tail = ` (${date})`;
  const body = truncate(
    entry.description,
    MAX_GRAPHEMES - head.length - tail.length,
  );
  const text = truncate(`${head}${body}${tail}`, MAX_GRAPHEMES);
  const doc = entry.documents?.[0];
  return {
    $type: "app.bsky.feed.post",
    text,
    createdAt,
    embed: {
      $type: "app.bsky.embed.external",
      external: {
        uri: doc?.sourceUrl ?? viewUrl,
        title: `${caseName} — ${label || "Filing"}`.trim(),
        description: truncate(entry.description, 280),
      },
    },
    labels: BOT_SELF_LABEL,
  };
}
