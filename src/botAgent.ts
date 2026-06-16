// pattern: Imperative Shell
// The bot's own atproto session: read mention notifications and post threaded
// replies as @ape.rcape.org. `BotAgent` is the seam bot.ts is tested against —
// the live implementation wraps an AtpAgent; tests pass a plain mock.

import { AtpAgent } from "@atproto/api";
import type { GraphClient } from "./allowlist.js";
import { DEFAULT_PDS_HOST } from "./caseRepo.js";
import { BOT_SELF_LABEL } from "./companionPost.js";
import {
  type MentionFacet,
  type RichtextRecord,
  extractPostLinks,
} from "./facet.js";
import type { StrongRef } from "./queue.js";
import type { ThreadView } from "./thread.js";

const POST = "app.bsky.feed.post";
// How many ancestor levels getPostThread returns for thread-scan. depth:0 skips
// replies entirely (we only walk upward toward the root).
const THREAD_PARENT_HEIGHT = 10;

export interface MentionNotif {
  uri: string;
  cid: string;
  authorDid: string;
  authorHandle: string;
  text: string;
  // URIs from the post's link facets AND its external link card. The full URL
  // lives here even when `text` shows a Bluesky-truncated version
  // (".../docket/71795..."), so docket parsing must prefer these over the text.
  links?: string[];
  root: StrongRef; // thread root (the mention itself if it's a top-level post)
  // How this notification reached us: an explicit @-mention (intentional
  // request — "reply to everyone" applies) or a plain reply to one of the bot's
  // own posts (a conversation continuation — a contentless reply like "thanks"
  // must NOT draw a decline/no-docket nudge). Absent ⇒ treated as a mention.
  source?: "mention" | "reply";
}

// The slice of a listNotifications response paginateMentions consumes. Kept
// minimal + structurally typed so tests can feed plain objects.
export interface RawNotification {
  uri: string;
  cid: string;
  reason: string;
  author: { did: string; handle: string };
  record: unknown;
  indexedAt: string;
}
export interface ListNotificationsPage {
  notifications: RawNotification[];
  cursor?: string;
}

export interface ListMentionsOpts {
  // Stop paginating once a notification we've already processed is reached —
  // notifications come newest-first, so an already-seen URI means everything
  // below it on this and later pages is also old.
  isSeen?: (uri: string) => boolean;
}

export interface BotAgent {
  did: string;
  graph: GraphClient;
  listMentions(opts?: ListMentionsOpts): Promise<MentionNotif[]>;
  reply(
    parent: StrongRef,
    root: StrongRef,
    text: string,
    facets?: MentionFacet[],
  ): Promise<StrongRef>;
  // Mark notifications up to `seenAt` as read, so the bot account's unread badge
  // clears and the next listNotifications can rely on the server's seen marker.
  updateSeen(seenAt: string): Promise<void>;
  // Fetch the thread rooted at `uri` (the mention) so a mention carrying no
  // docket can still resolve one present in an ancestor or quoted post. Returns
  // the raw thread view (or null when the post is gone); the caller scans it.
  getPostThread(uri: string): Promise<ThreadView | null>;
}

function toMention(n: RawNotification): MentionNotif {
  const record = n.record as RichtextRecord & {
    text?: string;
    reply?: { root?: { uri: string; cid: string } };
  };
  const links = extractPostLinks(record);
  return {
    uri: n.uri,
    cid: n.cid,
    authorDid: n.author.did,
    authorHandle: n.author.handle,
    text: record.text ?? "",
    links,
    root: record.reply?.root ?? { uri: n.uri, cid: n.cid },
    source: n.reason === "reply" ? "reply" : "mention",
  };
}

// pattern: Functional Core
// Walk listNotifications cursor pages, collecting `mention` AND `reply`
// notifications, until the cursor is absent or an already-seen URI is reached. A
// single 50-notif page can be all likes/follows with real mentions scrolled off
// the bottom; without pagination those would be silently dropped, violating
// "reply to everyone". A `reply` notification is, by definition, a reply to one
// of the bot's OWN posts — so a user can hand the Librarian a docket link by
// replying to its "reply with a link" prompt, without re-typing the @handle (the
// natural move that previously fell into silence). The contentless-reply noise
// this admits is suppressed downstream by `source`, not here.
const COLLECTED_REASONS = new Set(["mention", "reply"]);
const PAGE_GUARD = 50; // hard ceiling on pages so a server cursor bug can't loop forever
export async function paginateMentions(
  fetchPage: (cursor?: string) => Promise<ListNotificationsPage>,
  opts: ListMentionsOpts = {},
): Promise<MentionNotif[]> {
  const isSeen = opts.isSeen ?? (() => false);
  const out: MentionNotif[] = [];
  let cursor: string | undefined;
  let guard = 0;
  do {
    const data = await fetchPage(cursor);
    for (const n of data.notifications) {
      if (isSeen(n.uri)) return out; // hit the processed boundary — done
      if (!COLLECTED_REASONS.has(n.reason)) continue;
      out.push(toMention(n));
    }
    cursor = data.cursor;
  } while (cursor && ++guard < PAGE_GUARD);
  return out;
}

export async function createBotAgent(opts: {
  host?: string;
  identifier: string;
  password: string;
}): Promise<BotAgent> {
  const agent = new AtpAgent({
    service: `https://${opts.host ?? DEFAULT_PDS_HOST}`,
  });
  await agent.login({ identifier: opts.identifier, password: opts.password });
  const did = agent.session?.did;
  if (!did) throw new Error("bot login failed: no session DID");

  return {
    did,
    // Double-cast: AtpAgent structurally provides the app.bsky.graph.* methods
    // GraphClient names, but its full type is far wider, so TS won't narrow it
    // directly. The cast is sound at runtime (the methods exist); GraphClient is
    // the minimal seam tests mock against.
    graph: agent as unknown as GraphClient,
    async listMentions(opts): Promise<MentionNotif[]> {
      return paginateMentions(async (cursor) => {
        const { data } = await agent.app.bsky.notification.listNotifications({
          limit: 50,
          cursor,
          // Server-side filter so likes/follows/reposts don't consume page slots;
          // paginateMentions still re-checks reason defensively. `reply` is here
          // so replies to the bot's own posts (a link handed back in
          // conversation) are processed, not just explicit @-mentions.
          reasons: ["mention", "reply"],
        });
        return {
          notifications:
            data.notifications as ListNotificationsPage["notifications"],
          cursor: data.cursor,
        };
      }, opts);
    },
    async reply(parent, root, text, facets): Promise<StrongRef> {
      const res = await agent.com.atproto.repo.createRecord({
        repo: did,
        collection: POST,
        record: {
          $type: POST,
          text,
          createdAt: new Date().toISOString(),
          reply: { root, parent },
          labels: BOT_SELF_LABEL,
          // Mention facets notify + link the @handles in the copy; omitted when
          // a reply has none (no-docket/not-found/ack) so the field stays absent.
          ...(facets && facets.length > 0 ? { facets } : {}),
        },
      });
      return { uri: res.data.uri, cid: res.data.cid };
    },
    async updateSeen(seenAt): Promise<void> {
      await agent.app.bsky.notification.updateSeen({ seenAt });
    },
    async getPostThread(uri): Promise<ThreadView | null> {
      const { data } = await agent.app.bsky.feed.getPostThread({
        uri,
        depth: 0,
        parentHeight: THREAD_PARENT_HEIGHT,
      });
      // The atproto union (ThreadViewPost | NotFound | Blocked) is wider than the
      // structural slice thread.ts walks; the cast is sound (it reads only the
      // fields that exist), and NotFound/Blocked roots scan to no docket.
      return data.thread as unknown as ThreadView;
    },
  };
}
