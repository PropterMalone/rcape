// pattern: Imperative Shell
// The bot's own atproto session: read mention notifications and post threaded
// replies as @ape.rcape.org. `BotAgent` is the seam bot.ts is tested against —
// the live implementation wraps an AtpAgent; tests pass a plain mock.

import { AtpAgent } from "@atproto/api";
import type { GraphClient } from "./allowlist.js";
import { DEFAULT_PDS_HOST } from "./caseRepo.js";
import { BOT_SELF_LABEL } from "./companionPost.js";
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

export interface BotAgent {
  did: string;
  graph: GraphClient;
  listMentions(): Promise<MentionNotif[]>;
  reply(parent: StrongRef, root: StrongRef, text: string): Promise<StrongRef>;
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
    graph: agent as unknown as GraphClient,
    async listMentions(): Promise<MentionNotif[]> {
      const { data } = await agent.app.bsky.notification.listNotifications({
        limit: 50,
      });
      const out: MentionNotif[] = [];
      for (const n of data.notifications) {
        if (n.reason !== "mention") continue;
        const record = n.record as {
          text?: string;
          reply?: { root?: { uri: string; cid: string } };
        };
        out.push({
          uri: n.uri,
          cid: n.cid,
          authorDid: n.author.did,
          authorHandle: n.author.handle,
          text: record.text ?? "",
          root: record.reply?.root ?? { uri: n.uri, cid: n.cid },
        });
      }
      return out;
    },
    async reply(parent, root, text): Promise<StrongRef> {
      const res = await agent.com.atproto.repo.createRecord({
        repo: did,
        collection: POST,
        record: {
          $type: POST,
          text,
          createdAt: new Date().toISOString(),
          reply: { root, parent },
          labels: BOT_SELF_LABEL,
        },
      });
      return { uri: res.data.uri, cid: res.data.cid };
    },
  };
}
