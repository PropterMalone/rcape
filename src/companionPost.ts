// pattern: Functional Core
// Maps a docket entry to a companion app.bsky.feed.post so that following the
// case account in any standard Bluesky client surfaces new filings in-timeline.
// These are STAGED, not auto-published (outbound-message rule).

import type { DocketEntryRecord } from "./map.js";

interface BskyExternalEmbed {
  $type: "app.bsky.embed.external";
  external: { uri: string; title: string; description: string };
}

interface BskyPost {
  $type: "app.bsky.feed.post";
  text: string;
  createdAt: string;
  embed?: BskyExternalEmbed;
}

const MAX_GRAPHEMES = 300;

function truncate(s: string, n: number): string {
  const t = s.trim();
  return t.length <= n ? t : `${t.slice(0, Math.max(0, n - 1)).trimEnd()}…`;
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
  };
}
