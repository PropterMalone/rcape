// pattern: Functional Core
// Scans a fetched Bluesky thread for an explicit docket LINK, so a mention that
// itself carries no docket can still resolve one already present in the thread it
// replies to. This is the v1a base under v1b's prose inference. Deliberately
// link-only (parseDocketLink, never the bare-number heuristic): an ancestor post
// isn't addressed to the bot, and a wrong guess burns ~17 CL calls — weak/prose
// signals are v1b's job, behind a confidence gate.

import { type RichtextRecord, extractLinkFacets } from "./facet.js";
import { parseDocketLink } from "./mention.js";

// Client-side belt to getPostThread's parentHeight: cap how far up we walk.
const MAX_ANCESTORS = 10;

type PostRecord = RichtextRecord & { text?: string };

// A minimal structural slice of @atproto/api's ThreadViewPost — enough to walk
// the ancestor chain and read each post's text, link facets, and quoted record.
interface ThreadEmbed {
  $type?: string;
  record?: { value?: PostRecord };
}
interface ThreadPost {
  record?: PostRecord;
  embed?: ThreadEmbed;
}
// A parent node is either another ThreadViewPost or a NotFound/Blocked stub. The
// stubs carry no `post`, which terminates the upward walk — we can't see above a
// deleted or blocked post anyway.
type ThreadNode = ThreadView | { notFound: true } | { blocked: true };
export interface ThreadView {
  post?: ThreadPost;
  parent?: ThreadNode;
}

// The quoted post's record, only for a plain quote embed (record#view). A
// quote-with-media (recordWithMedia#view) nests the record one level deeper and
// is intentionally NOT handled — it falls through to no-docket, which is safe
// (v1b can still infer from the surrounding text).
function quotedRecord(embed: ThreadEmbed | undefined): PostRecord | undefined {
  if (embed?.$type !== "app.bsky.embed.record#view") return undefined;
  return embed.record?.value;
}

type Entry = { text: string; links: string[] };

function entry(record: PostRecord): Entry {
  return { text: record.text ?? "", links: extractLinkFacets(record) };
}

function postEntries(post: ThreadPost): Entry[] {
  const out: Entry[] = [entry(post.record ?? {})];
  const quoted = quotedRecord(post.embed);
  if (quoted) out.push(entry(quoted));
  return out;
}

// In-scope posts, in scan order: the mention's own quoted post first (the most
// direct "look at THIS case" gesture), then ancestors nearest-first (immediate
// parent up to root), each contributing its text+links and its own quote. The
// mention's own text+links are excluded — the caller already parsed those via
// parseMention.
export function collectThreadPosts(thread: ThreadView | undefined): Entry[] {
  const entries: Entry[] = [];
  const ownQuote = quotedRecord(thread?.post?.embed);
  if (ownQuote) entries.push(entry(ownQuote));
  let node = thread?.parent;
  let depth = 0;
  while (node && "post" in node && node.post && depth < MAX_ANCESTORS) {
    entries.push(...postEntries(node.post));
    node = node.parent;
    depth++;
  }
  return entries;
}

// The first explicit docket link in the thread, scanned nearest-context-first.
export function scanThreadForDocket(
  thread: ThreadView | undefined,
): { docketId: number } | null {
  for (const { text, links } of collectThreadPosts(thread)) {
    const hit = parseDocketLink(text, links);
    if (hit) return hit;
  }
  return null;
}
