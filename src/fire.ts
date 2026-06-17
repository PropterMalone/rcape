// pattern: Imperative Shell
// Publishes the social layer for a case backfill: the profile, one pinned seed
// post, and one BACKDATED doc-post per docket entry (createdAt = filing date),
// linking each post back onto its docketEntry record (docPost strongRef) so a
// takedown removes the post with the entry. QTs are forward-only (the monitor),
// NOT part of the backfill. `fireBackfill` is the callable core (also used by the
// provisioner); the CLI adds a `--dry-run` preview and `--force` override.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { CaseRepo } from "./caseRepo.js";
import {
  BOT_SELF_LABEL,
  backdatedCreatedAts,
  entryToPost,
  truncate,
} from "./companionPost.js";
import { courtLabel } from "./courts.js";
import type { DocketEntryRecord, DocketRecord, PostRef } from "./map.js";

const DOCKET = "org.rcape.docket";
const ENTRY = "org.rcape.docketEntry";
const POST = "app.bsky.feed.post";
const PROFILE = "app.bsky.actor.profile";

export interface LiveEntry {
  rkey: string;
  value: DocketEntryRecord;
}

async function loadDocket(repo: CaseRepo): Promise<DocketRecord> {
  return (await repo.getRecord(DOCKET, "self")) as unknown as DocketRecord;
}

async function loadEntries(repo: CaseRepo): Promise<LiveEntry[]> {
  const out: LiveEntry[] = [];
  for await (const r of repo.listAll(ENTRY)) {
    out.push({ rkey: r.rkey, value: r.value as unknown as DocketEntryRecord });
  }
  out.sort((a, b) =>
    (a.value.recapSequenceNumber ?? "").localeCompare(
      b.value.recapSequenceNumber ?? "",
    ),
  );
  return out;
}

async function hasAnyPosts(repo: CaseRepo): Promise<boolean> {
  for await (const _post of repo.listAll(POST)) {
    return true;
  }
  return false;
}

export interface ProfileAndSeed {
  profile: Record<string, unknown>;
  seedText: string;
}

export function buildProfileAndSeed(docket: DocketRecord): ProfileAndSeed {
  const profile = {
    $type: PROFILE,
    displayName: truncate(docket.caseName, 64),
    description: truncate(
      `Unofficial mirror of federal docket ${docket.docketNumber} (${courtLabel(docket.court)}), Judge ${docket.assignedJudge}. Browse the docket or follow for new entries. Shelved by @ape.rcape.org. Source: CourtListener.`,
      256,
    ),
    labels: BOT_SELF_LABEL,
  };
  const seedText = truncate(
    `${docket.caseName} (${docket.docketNumber}) is now mirrored here, filing by filing. Browse the docket as signed records, or follow for new activity. Unofficial; source: CourtListener.`,
    300,
  );
  return { profile, seedText };
}

export interface FireResult {
  published: number;
  failed: string[];
}

// Post one BACKDATED companion doc-post per docket entry and link it back onto
// the entry record (docPost strongRef). The entries MUST already exist as records
// in the repo (their rkeys are used to attach the docPost). Shared by the initial
// backfill (all entries) and the watched-case monitor (only the new ones) so both
// get the unique strictly-increasing createdAt fix. Per-entry failures are
// collected, never thrown — a flaky post leaves that entry below the high-water
// line so the next pass retries it.
export async function postEntries(
  repo: CaseRepo,
  entries: LiveEntry[],
  caseName: string,
  caseUrl: string,
): Promise<FireResult> {
  // Unique strictly-increasing createdAt per post (see backdatedCreatedAts): a
  // shared date-only timestamp would make the AppView feed show one filing per
  // day, hiding the rest. Order matches the publish loop below.
  const createdAts = backdatedCreatedAts(entries.map((e) => e.value.dateFiled));

  let published = 0;
  const failed: string[] = [];
  for (const [i, e] of entries.entries()) {
    try {
      const post = entryToPost(
        e.value,
        caseName,
        caseUrl,
        createdAts[i] ?? e.value.dateFiled,
      );
      const created = await repo.createRecord(
        POST,
        post as unknown as Record<string, unknown>,
      );
      const docPost: PostRef = { uri: created.uri, cid: created.cid };
      await repo.putRecord(ENTRY, e.rkey, {
        ...e.value,
        docPost,
      } as unknown as Record<string, unknown>);
      if (++published % 25 === 0) {
        console.log(`  posted ${published}/${entries.length}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  entry ${e.rkey} failed: ${msg}`);
      failed.push(e.rkey);
    }
  }
  return { published, failed };
}

export async function fireBackfill(
  repo: CaseRepo,
  opts: { force?: boolean } = {},
): Promise<FireResult> {
  const docket = await loadDocket(repo);
  const entries = await loadEntries(repo);
  if ((await hasAnyPosts(repo)) && !opts.force) {
    throw new Error(
      "refusing to fire: posts already exist on the account. Pass force only if you intend duplicates.",
    );
  }
  const caseUrl = docket.source.url ?? "https://www.courtlistener.com/";
  const now = new Date().toISOString();
  const { profile, seedText } = buildProfileAndSeed(docket);

  // Same seal avatar as the bot, so each case thread reads as part of the
  // library. Backfill still succeeds if the asset is missing.
  let avatar: unknown;
  try {
    const path = fileURLToPath(
      new URL("../assets/avatar.png", import.meta.url),
    );
    avatar = await repo.uploadBlob(
      new Uint8Array(await readFile(path)),
      "image/png",
    );
  } catch (e) {
    console.warn(`  no case avatar set: ${e instanceof Error ? e.message : e}`);
  }

  const seed = await repo.createRecord(POST, {
    $type: POST,
    text: seedText,
    createdAt: now,
    labels: BOT_SELF_LABEL,
  });
  await repo.putRecord(PROFILE, "self", {
    ...profile,
    ...(avatar ? { avatar } : {}),
    pinnedPost: { uri: seed.uri, cid: seed.cid },
    createdAt: now,
  });
  console.log("profile + pinned seed published");

  const { published, failed } = await postEntries(
    repo,
    entries,
    docket.caseName,
    caseUrl,
  );
  console.log(
    `done — ${published}/${entries.length} doc-posts published, ${failed.length} failed on @${repo.handle}.`,
  );
  if (failed.length > 0) console.error(`failed rkeys: ${failed.join(", ")}`);
  return { published, failed };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const force = process.argv.includes("--force");
  const identifier = process.env.RCAPE_CASE_DID;
  const password = process.env.RCAPE_CASE_PASSWORD;
  if (!identifier || !password) {
    throw new Error("RCAPE_CASE_DID / RCAPE_CASE_PASSWORD not set");
  }
  const repo = await CaseRepo.login({
    host: process.env.PDS_HOSTNAME,
    identifier,
    password,
  });

  if (dryRun) {
    const docket = await loadDocket(repo);
    const entries = await loadEntries(repo);
    const caseUrl = docket.source.url ?? "https://www.courtlistener.com/";
    const { profile, seedText } = buildProfileAndSeed(docket);
    console.log("=== [dry-run] nothing published ===");
    console.log("displayName:", profile.displayName);
    console.log("description:", profile.description);
    console.log("seed post:", seedText);
    console.log(`backfill: ${entries.length} backdated doc-posts (no QTs)`);
    console.log("most-recent 3 samples:");
    for (const e of entries.slice(-3)) {
      const p = entryToPost(
        e.value,
        docket.caseName,
        caseUrl,
        e.value.dateFiled,
      );
      console.log(`  [${p.createdAt.slice(0, 10)}] ${truncate(p.text, 140)}`);
    }
    const oldest = entries[0];
    if (oldest) {
      const p = entryToPost(
        oldest.value,
        docket.caseName,
        caseUrl,
        oldest.value.dateFiled,
      );
      console.log("oldest 1 sample:");
      console.log(`  [${p.createdAt.slice(0, 10)}] ${truncate(p.text, 140)}`);
    }
    return;
  }

  await fireBackfill(repo, { force });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
