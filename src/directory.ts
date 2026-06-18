// pattern: Functional Core
// Pure builders for RC Ape's public "shelf" directory: the markdown table pushed
// to the PropterMalone gist, the combined pinned-post copy, and the graph.list
// membership diff. No I/O — the orchestration (gist PATCH, atproto records) lives
// in directorySync.ts (Imperative Shell).

import type { CaseEntry } from "./ledger.js";

// The existing, hand-authored "how it works" gist. Single source of truth for
// the URL — initBot.ts imports this for the bio so the two never drift apart.
export const HOW_IT_WORKS_GIST =
  "https://gist.github.com/PropterMalone/579b9d77577fe45c3cb540905ba7d6ec";
const OWNER_PROFILE = "https://bsky.app/profile/proptermalone.bsky.social";
const BOT_PROFILE = "https://bsky.app/profile/ape.rcape.org";

const EM_DASH = "—";

// Escape the markdown table cell delimiter so a case name containing "|" can't
// inject extra columns (CL case names do carry pipes occasionally).
function cell(value: string | undefined): string {
  if (value === undefined || value === "") return EM_DASH;
  return value.replace(/\|/g, "\\|");
}

function profileLink(handle: string): string {
  return `[@${handle}](https://bsky.app/profile/${handle})`;
}

// The gist body: a newest-first table of every COMPLETED case. Incomplete
// (crash-zombie) entries are excluded — they have no live, resolvable handle yet.
export function buildDirectoryMarkdown(cases: CaseEntry[]): string {
  const completed = cases
    .filter((c) => c.completed)
    // Descending createdAt (newest shelved first). localeCompare on ISO strings
    // orders chronologically; reversed for newest-first.
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const rows = completed.map(
    (c) =>
      `| ${cell(c.caseName)} | ${cell(c.courtName)} | ${cell(c.docketNumber)} | ${profileLink(
        c.handle,
      )} | ${c.filings ?? EM_DASH} |`,
  );

  const count = completed.length;
  const noun = count === 1 ? "docket" : "dockets";
  return [
    "# R.C. Ape — Shelved Dockets",
    "",
    `${count} U.S. federal ${noun} mirrored as native AT Protocol repositories. Each is a live, followable account; mention [@ape.rcape.org](${BOT_PROFILE}) with a CourtListener docket link to add one.`,
    "",
    "| Case | Court | Docket # | Account | Filings |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
    `_Auto-updated as cases are shelved · tended by [@proptermalone.bsky.social](${OWNER_PROFILE})._`,
    "",
  ].join("\n");
}

// The combined pinned-post copy: links the shelf gist. The how-it-works link is
// dropped here (it already lives in the bio) so the post stays under the 300-
// grapheme app.bsky.feed.post cap with a real 32-char gist id. Set once (the gist
// URL is stable), so this is not regenerated per case.
export function buildPinnedPostText(shelfGistUrl: string): string {
  return [
    "🦍 R.C. Ape mirrors U.S. federal court dockets from RECAP as native AT Protocol repos. Mention me with a CourtListener docket link and I shelve it.",
    "",
    `→ The full shelf: ${shelfGistUrl}`,
  ].join("\n");
}

// Which case account DIDs still need a graph.list listitem: the completed-case
// DIDs not already present as a list subject. Order-preserving + deduped so a
// repeated regenerate adds nothing twice.
export function listMembershipDiff(
  completedDids: string[],
  existingSubjectDids: Set<string>,
): string[] {
  const out: string[] = [];
  const seen = new Set(existingSubjectDids);
  for (const did of completedDids) {
    if (seen.has(did)) continue;
    seen.add(did);
    out.push(did);
  }
  return out;
}
