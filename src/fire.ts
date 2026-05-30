// pattern: Imperative Shell
// Publishes the social layer for the case backfill: the profile, one pinned seed
// post, and one BACKDATED doc-post per docket entry (createdAt = filing date),
// linking each post back onto its docketEntry record (docPost strongRef) so a
// takedown removes the post with the entry. QTs are forward-only (the monitor),
// NOT part of the backfill. `--dry-run` stages without publishing. Idempotency:
// refuses to run if doc-posts already exist unless `--force`.

import { AtpAgent } from "@atproto/api";
import { BOT_SELF_LABEL, entryToPost, truncate } from "./companionPost.js";
import type { DocketEntryRecord, DocketRecord, PostRef } from "./map.js";

const DOCKET = "org.rcape.docket";
const ENTRY = "org.rcape.docketEntry";
const POST = "app.bsky.feed.post";
const PROFILE = "app.bsky.actor.profile";

interface LiveEntry {
  rkey: string;
  value: DocketEntryRecord;
}

const COURT_LABELS: Record<string, string> = { mdd: "D. Md." };
function courtLabel(id: string): string {
  return COURT_LABELS[id] ?? id;
}

async function loadDocket(agent: AtpAgent, did: string): Promise<DocketRecord> {
  const { data } = await agent.com.atproto.repo.getRecord({
    repo: did,
    collection: DOCKET,
    rkey: "self",
  });
  return data.value as unknown as DocketRecord;
}

async function loadEntries(agent: AtpAgent, did: string): Promise<LiveEntry[]> {
  const out: LiveEntry[] = [];
  let cursor: string | undefined;
  do {
    const { data } = await agent.com.atproto.repo.listRecords({
      repo: did,
      collection: ENTRY,
      limit: 100,
      cursor,
    });
    for (const r of data.records) {
      const rkey = r.uri.split("/").pop();
      if (rkey)
        out.push({ rkey, value: r.value as unknown as DocketEntryRecord });
    }
    cursor = data.cursor;
  } while (cursor);
  out.sort((a, b) =>
    (a.value.recapSequenceNumber ?? "").localeCompare(
      b.value.recapSequenceNumber ?? "",
    ),
  );
  return out;
}

async function hasAnyPosts(agent: AtpAgent, did: string): Promise<boolean> {
  const { data } = await agent.com.atproto.repo.listRecords({
    repo: did,
    collection: POST,
    limit: 1,
  });
  return data.records.length > 0;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const force = process.argv.includes("--force");
  const host = process.env.PDS_HOSTNAME ?? "pds.rcape.org";
  const did = process.env.CRANCH_CASE_DID;
  const password = process.env.CRANCH_CASE_PASSWORD;
  if (!did || !password) {
    throw new Error("CRANCH_CASE_DID / CRANCH_CASE_PASSWORD not set");
  }

  const agent = new AtpAgent({ service: `https://${host}` });
  await agent.login({ identifier: did, password });

  const docket = await loadDocket(agent, did);
  const entries = await loadEntries(agent, did);
  const caseUrl = docket.source.url ?? "https://www.courtlistener.com/";
  const now = new Date().toISOString();

  const profile = {
    $type: PROFILE,
    displayName: truncate(docket.caseName, 64),
    description: truncate(
      `Unofficial mirror of federal docket ${docket.docketNumber} (${courtLabel(docket.court)}), Judge ${docket.assignedJudge}. Each filing is a signed, content-addressed record — browse the docket or follow for new filings. Source: CourtListener.`,
      256,
    ),
    labels: BOT_SELF_LABEL,
  };
  const seedText = truncate(
    `${docket.caseName} (${docket.docketNumber}) is now mirrored here, filing by filing — browse the docket as signed records or follow for new activity. Unofficial; source: CourtListener.`,
    300,
  );

  if (dryRun) {
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
    console.log("oldest 1 sample:");
    const o = entries[0];
    if (o) {
      const p = entryToPost(
        o.value,
        docket.caseName,
        caseUrl,
        o.value.dateFiled,
      );
      console.log(`  [${p.createdAt.slice(0, 10)}] ${truncate(p.text, 140)}`);
    }
    return;
  }

  const alreadyHasPosts = await hasAnyPosts(agent, did);
  if (alreadyHasPosts && !force) {
    throw new Error(
      "refusing to fire: posts already exist on the account. Re-run with --force only if you intend duplicates.",
    );
  }

  // 1. pinned seed (current-dated)
  const seed = await agent.com.atproto.repo.createRecord({
    repo: did,
    collection: POST,
    record: {
      $type: POST,
      text: seedText,
      createdAt: now,
      labels: BOT_SELF_LABEL,
    },
  });
  // 2. profile, pinning the seed
  await agent.com.atproto.repo.putRecord({
    repo: did,
    collection: PROFILE,
    rkey: "self",
    record: {
      ...profile,
      pinnedPost: { uri: seed.data.uri, cid: seed.data.cid },
      createdAt: now,
    },
  });
  console.log("profile + pinned seed published");

  // 3. backfill backdated doc-posts, linking each onto its entry
  let i = 0;
  const failures: string[] = [];
  for (const e of entries) {
    try {
      const post = entryToPost(
        e.value,
        docket.caseName,
        caseUrl,
        e.value.dateFiled,
      );
      const created = await agent.com.atproto.repo.createRecord({
        repo: did,
        collection: POST,
        record: post,
      });
      const docPost: PostRef = {
        uri: created.data.uri,
        cid: created.data.cid,
      };
      await agent.com.atproto.repo.putRecord({
        repo: did,
        collection: ENTRY,
        rkey: e.rkey,
        record: { ...e.value, docPost },
      });
      if (++i % 25 === 0) console.log(`  posted ${i}/${entries.length}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  entry ${e.rkey} failed: ${msg}`);
      failures.push(e.rkey);
    }
  }
  const total = entries.length;
  console.log(
    `done — ${i}/${total} doc-posts published, ${failures.length} failed on @${agent.session?.handle ?? did}.`,
  );
  if (failures.length > 0) {
    console.error(`failed rkeys: ${failures.join(", ")}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
