// pattern: Imperative Shell
// Regenerates RC Ape's public "shelf" directory from the ledger after a provision
// (or a monitor add): PATCHes the PropterMalone gist with the markdown table and,
// once, posts + pins a combined intro that links both the how-it-works and the
// shelf gist. STRICTLY best-effort — every failure is logged and swallowed so a
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
import { loadLedger } from "./ledger.js";
import type { StrongRef } from "./queue.js";

const POST = "app.bsky.feed.post";
const PROFILE = "app.bsky.actor.profile";
const LIST = "app.bsky.graph.list";
const LISTITEM = "app.bsky.graph.listitem";
const SHELF_GIST_FILE = "shelved-dockets.md";
// Fixed rkey for the combined intro post, so the pin is set exactly once: a later
// regenerate sees the pin already points at this rkey and skips the rewrite.
const PIN_RKEY = "shelfintro";
// Fixed rkey for the followable case-account list, so its AT-URI is deterministic
// (no need to round-trip the create result) and it's created exactly once.
const LIST_RKEY = "shelf";

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

// Set the combined pinned post exactly once. Idempotent: if the profile already
// pins our fixed-rkey intro, do nothing. Otherwise create the intro post (at the
// fixed rkey) and re-pin it, merging over the existing profile so displayName /
// description / avatar are preserved.
async function ensurePinnedPost(
  agent: DirectoryAgent,
  gistId: string,
): Promise<void> {
  const profile = (await agent.getRecord(PROFILE, "self")) as
    | { pinnedPost?: { uri: string; cid: string } }
    | undefined;
  if (profile?.pinnedPost?.uri.endsWith(`/${PIN_RKEY}`)) return; // already ours

  const text = buildPinnedPostText(shelfGistUrl(gistId));
  const ref = await agent.putRecord(POST, PIN_RKEY, {
    $type: POST,
    text,
    facets: linkFacets(text),
    createdAt: new Date().toISOString(),
    labels: BOT_SELF_LABEL,
  });
  await agent.putRecord(PROFILE, "self", {
    ...(profile ?? {}),
    $type: PROFILE,
    pinnedPost: ref,
  });
}

// Ensure a followable `app.bsky.graph.list` of the case accounts exists and holds
// a listitem for every completed case. Idempotent: the list is created once (fixed
// rkey → deterministic AT-URI), and only case DIDs not already in the list get a
// new listitem. Reads are PDS-local (the bot's own repo), so no CL quota is spent.
async function ensureListMembership(
  agent: DirectoryAgent,
  completedDids: string[],
): Promise<void> {
  const listUri = `at://${agent.did}/${LIST}/${LIST_RKEY}`;
  if (!(await agent.getRecord(LIST, LIST_RKEY))) {
    await agent.putRecord(LIST, LIST_RKEY, {
      $type: LIST,
      purpose: "app.bsky.graph.defs#curatelist",
      name: "R.C. Ape — Shelved Dockets",
      description:
        "Every U.S. federal docket R.C. Ape has mirrored as a native AT Protocol repo. Follow along.",
      createdAt: new Date().toISOString(),
    });
  }
  const existing = await agent.listRecords(LISTITEM);
  const existingSubjects = new Set(
    existing
      .map((r) => (r.value as { subject?: string }).subject)
      .filter((s): s is string => typeof s === "string"),
  );
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
    // regardless of the gist config).
    await ensureListMembership(
      agent,
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
