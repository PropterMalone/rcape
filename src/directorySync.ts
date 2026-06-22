// pattern: Imperative Shell
// Regenerates RC Ape's public "shelf" directory from the ledger after a provision
// (or a monitor add): PATCHes the PropterMalone gist with the markdown table and,
// once, posts + pins a combined intro that links both the how-it-works and the
// shelf gist. Best-effort — every failure is logged and swallowed so a
// gist/atproto hiccup can never fail a provision or its reply. Pure builders live
// in directory.ts (Functional Core).

import { BOT_SELF_LABEL } from "./companionPost.js";
import {
  buildDirectoryMarkdown,
  buildPinnedPostText,
  listMembershipDiff,
} from "./directory.js";
import { linkFacets } from "./facet.js";
import { type GistUpdateResult, updateGist } from "./gistClient.js";
import { loadLedger, mutateLedger, recordDirectoryListRkey } from "./ledger.js";
import type { StrongRef } from "./queue.js";
import { nextRkey } from "./repo.js";

const POST = "app.bsky.feed.post";
const PROFILE = "app.bsky.actor.profile";
const LIST = "app.bsky.graph.list";
const LISTITEM = "app.bsky.graph.listitem";
const SHELF_GIST_FILE = "shelved-dockets.md";

// Structural deps so directorySync doesn't import BotDeps from bot.ts (which
// imports this module). The live BotDeps (BotAgent + ProvisionConfig) satisfies it.
export interface DirectoryAgent {
  did: string;
  createRecord(collection: string, record: unknown): Promise<StrongRef>;
  putRecord(
    collection: string,
    rkey: string,
    record: unknown,
  ): Promise<StrongRef>;
  getRecord(collection: string, rkey: string): Promise<unknown | undefined>;
  listRecords(collection: string): Promise<{ uri: string; value: unknown }[]>;
  deleteRecord(collection: string, rkey: string): Promise<void>;
}

export interface DirectoryDeps {
  agent: DirectoryAgent;
  cfg: { ledgerPath: string; gistToken?: string; gistId?: string };
}

// The stable public URL of the shelf gist (owned by PropterMalone, like the
// how-it-works gist). Used in the pinned post copy.
function shelfGistUrl(gistId: string): string {
  return `https://gist.github.com/PropterMalone/${gistId}`;
}

// The rkey of a post AT-URI: at://<did>/app.bsky.feed.post/<rkey>.
function rkeyFromUri(uri: string): string {
  return uri.slice(uri.lastIndexOf("/") + 1);
}

// Set the combined pinned post. The post uses a server-assigned TID rkey
// (app.bsky.feed.post is key:tid — a fixed rkey is rejected by the PDS), so
// idempotency keys off the profile's stored pinnedPost, not a fixed rkey: the pin
// is "ours and current" only when the pinned post still exists, is one of our
// posts, AND its text links the CURRENT shelf gist. A changed gistId re-pins a
// fresh post. Aborts WITHOUT writing the profile when the profile read fails
// (getRecord ⇒ undefined): the profile always exists post-init, so undefined
// there means a real PDS fault — spreading {} would wipe displayName/avatar/bio.
async function ensurePinnedPost(
  agent: DirectoryAgent,
  gistId: string,
): Promise<void> {
  const profile = (await agent.getRecord(PROFILE, "self")) as
    | { pinnedPost?: { uri: string; cid: string } }
    | undefined;
  if (profile === undefined) return; // read fault — never clobber a live profile

  const shelfUrl = shelfGistUrl(gistId);
  const pinnedUri = profile.pinnedPost?.uri;
  if (pinnedUri?.startsWith(`at://${agent.did}/${POST}/`)) {
    const pinned = (await agent.getRecord(POST, rkeyFromUri(pinnedUri))) as
      | { text?: string }
      | undefined;
    // Ours AND links the current shelf gist → nothing to do.
    if (pinned?.text?.includes(shelfUrl)) return;
  }

  const text = buildPinnedPostText(shelfUrl);
  const ref = await agent.createRecord(POST, {
    $type: POST,
    text,
    facets: linkFacets(text),
    createdAt: new Date().toISOString(),
    labels: BOT_SELF_LABEL,
  });
  await agent.putRecord(PROFILE, "self", {
    ...profile,
    $type: PROFILE,
    pinnedPost: ref,
  });
}

// Ensure a followable `app.bsky.graph.list` of the case accounts exists and holds
// exactly the completed-case DIDs. Idempotent: the list lives at `listRkey` (a
// persisted TID — app.bsky.graph.list is key:tid, so a fixed string is rejected
// by the PDS), put once at that stable rkey; completed DIDs not yet listed get a
// new listitem, AND listitems whose subject is no longer in the completed set (a
// superseded account from a --force re-provision, or any stale DID) are deleted —
// so the followable list never points at a dead/superseded account. Reads +
// writes are PDS-local (the bot's own repo), so no CL quota is spent.
async function ensureListMembership(
  agent: DirectoryAgent,
  listRkey: string,
  completedDids: string[],
): Promise<void> {
  const listUri = `at://${agent.did}/${LIST}/${listRkey}`;
  if (!(await agent.getRecord(LIST, listRkey))) {
    await agent.putRecord(LIST, listRkey, {
      $type: LIST,
      purpose: "app.bsky.graph.defs#curatelist",
      name: "R.C. Ape — Shelved Dockets",
      description:
        "Every U.S. federal docket R.C. Ape has mirrored as a native AT Protocol repo. Follow along.",
      createdAt: new Date().toISOString(),
    });
  }
  const existing = await agent.listRecords(LISTITEM);
  const wanted = new Set(completedDids);
  const existingSubjects = new Set<string>();
  for (const r of existing) {
    const subject = (r.value as { subject?: string }).subject;
    if (typeof subject !== "string") continue;
    existingSubjects.add(subject);
    // Prune a listitem whose subject is no longer a completed case (superseded by
    // a --force re-provision, or otherwise gone). rkey is the last path segment.
    if (!wanted.has(subject)) {
      await agent.deleteRecord(LISTITEM, rkeyFromUri(r.uri));
    }
  }
  for (const did of listMembershipDiff(completedDids, existingSubjects)) {
    await agent.createRecord(LISTITEM, {
      $type: LISTITEM,
      subject: did,
      list: listUri,
      createdAt: new Date().toISOString(),
    });
  }
}

// Regenerate the directory. `gistFn` is injectable for tests. Never throws.
export async function regenerateDirectory(
  deps: DirectoryDeps,
  gistFn: (
    token: string,
    gistId: string,
    filename: string,
    content: string,
  ) => Promise<GistUpdateResult> = updateGist,
): Promise<void> {
  try {
    const { cfg, agent } = deps;
    const ledger = await loadLedger(cfg.ledgerPath);
    const cases = Object.values(ledger.cases);

    // 1. Gist table (requires the owner token + gist id).
    if (cfg.gistToken && cfg.gistId) {
      const res = await gistFn(
        cfg.gistToken,
        cfg.gistId,
        SHELF_GIST_FILE,
        buildDirectoryMarkdown(cases),
      );
      if (!res.ok) console.error(`directory: gist update failed: ${res.error}`);
    }

    // 2. One-time combined pinned post (needs the gist id for the link).
    if (cfg.gistId) await ensurePinnedPost(agent, cfg.gistId);

    // 3. Followable native list of the case accounts (bot self-auth only — runs
    // regardless of the gist config). The list's rkey is a TID minted once and
    // persisted in the ledger, so its AT-URI (which followers reference) is stable
    // across restarts/regenerations. app.bsky.graph.list is key:tid — a fixed
    // string rkey is rejected by the PDS.
    let listRkey = ledger.directory?.listRkey;
    if (!listRkey) {
      listRkey = nextRkey();
      await mutateLedger(cfg.ledgerPath, (l) =>
        recordDirectoryListRkey(l, listRkey as string),
      );
    }
    await ensureListMembership(
      agent,
      listRkey,
      cases.filter((c) => c.completed).map((c) => c.did),
    );
  } catch (e) {
    // Best-effort: a directory failure must never bubble into the provision path.
    console.error(
      "directory: regenerate failed:",
      e instanceof Error ? e.message : String(e),
    );
  }
}
