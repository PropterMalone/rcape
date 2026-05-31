// pattern: Imperative Shell
// The bot's own atproto session: read mention notifications and post threaded
// replies as @ape.rcape.org. `BotAgent` is the seam bot.ts is tested against —
// the live implementation wraps an AtpAgent; tests pass a plain mock.

import { AtpAgent } from "@atproto/api";
import type { GraphClient } from "./allowlist.js";
import { DEFAULT_PDS_HOST } from "./caseRepo.js";
import { BOT_SELF_LABEL } from "./companionPost.js";
import type { MentionFacet } from "./facet.js";
import type { StrongRef } from "./queue.js";

const POST = "app.bsky.feed.post";

export interface MentionNotif {
  uri: string;
  cid: string;
  authorDid: string;
  authorHandle: string;
  text: string;
  root: StrongRef; // thread root (the mention itself if it's a top-level post)
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
}

function toMention(n: RawNotification): MentionNotif {
  const record = n.record as {
    text?: string;
    reply?: { root?: { uri: string; cid: string } };
  };
  return {
    uri: n.uri,
    cid: n.cid,
    authorDid: n.author.did,
    authorHandle: n.author.handle,
    text: record.text ?? "",
    root: record.reply?.root ?? { uri: n.uri, cid: n.cid },
  };
}

// pattern: Functional Core
// Walk listNotifications cursor pages, collecting `mention` notifications, until
// the cursor is absent or an already-seen URI is reached. A single 50-notif page
// can be all likes/follows with real mentions scrolled off the bottom; without
// pagination those mentions are silently dropped, violating "reply to everyone".
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
      if (n.reason !== "mention") continue;
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
          // Server-side filter so non-mention notifications don't consume page
          // slots; paginateMentions still re-checks reason defensively.
          reasons: ["mention"],
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
  };
}
