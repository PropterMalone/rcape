// pattern: Imperative Shell
// Takedown lever: removes records and/or their companion posts from a case repo
// on the live PDS, with a required reason and an append-only audit log. Implements
// "no more permissive than the source": honor court seals / CourtListener removals.
//
// Honest scope: removal is effective on THIS PDS and the canonical Bluesky AppView.
// Federation has no global erase — independent downstream replicators may retain
// copies. We remove the authoritative copy and signal the deletion; that's the
// meaningful action, not a guarantee of universal erasure.

import { appendFile, mkdir } from "node:fs/promises";
import { AtpAgent } from "@atproto/api";

interface DeleteTarget {
  collection: string;
  rkey: string;
}

const ENTRY_COLLECTION = "org.rcape.docketEntry";

function uriToTarget(uri: string): DeleteTarget | null {
  const m = uri.match(/^at:\/\/[^/]+\/([^/]+)\/([^/]+)$/);
  return m?.[1] && m[2] ? { collection: m[1], rkey: m[2] } : null;
}

interface TakedownArgs {
  whole: boolean;
  entry?: string;
  reason?: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): TakedownArgs {
  const args: TakedownArgs = { whole: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--case") args.whole = true;
    else if (a === "--entry") args.entry = argv[++i];
    else if (a === "--reason") args.reason = argv[++i];
    else if (a === "--dry-run") args.dryRun = true;
  }
  return args;
}

async function collectCaseTargets(
  agent: AtpAgent,
  did: string,
): Promise<DeleteTarget[]> {
  const targets: DeleteTarget[] = [];
  const { data: repo } = await agent.com.atproto.repo.describeRepo({
    repo: did,
  });
  for (const collection of repo.collections) {
    let cursor: string | undefined;
    do {
      const { data } = await agent.com.atproto.repo.listRecords({
        repo: did,
        collection,
        limit: 100,
        cursor,
      });
      for (const r of data.records) {
        const t = uriToTarget(r.uri);
        if (t) targets.push(t);
      }
      cursor = data.cursor;
    } while (cursor);
  }
  return targets;
}

async function collectEntryTargets(
  agent: AtpAgent,
  did: string,
  rkey: string,
): Promise<DeleteTarget[]> {
  const targets: DeleteTarget[] = [{ collection: ENTRY_COLLECTION, rkey }];
  try {
    const { data } = await agent.com.atproto.repo.getRecord({
      repo: did,
      collection: ENTRY_COLLECTION,
      rkey,
    });
    const v = data.value as {
      docPost?: { uri?: string };
      announcePost?: { uri?: string };
    };
    for (const ref of [v.docPost, v.announcePost]) {
      const t = ref?.uri ? uriToTarget(ref.uri) : null;
      if (t) targets.push(t);
    }
  } catch {
    console.warn(
      "could not read entry record for companion links; removing entry record only",
    );
  }
  return targets;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.reason) {
    throw new Error(
      "--reason is required (basis for the takedown; audit-logged)",
    );
  }
  if (!args.whole && !args.entry) {
    throw new Error("specify --case (whole case) or --entry <rkey>");
  }

  const host = process.env.PDS_HOSTNAME ?? "cranch.proptermalone.com";
  const did = process.env.CRANCH_CASE_DID;
  const password = process.env.CRANCH_CASE_PASSWORD;
  if (!did || !password) {
    throw new Error("CRANCH_CASE_DID / CRANCH_CASE_PASSWORD not set");
  }

  const agent = new AtpAgent({ service: `https://${host}` });
  await agent.login({ identifier: did, password });

  const targets = args.whole
    ? await collectCaseTargets(agent, did)
    : await collectEntryTargets(agent, did, args.entry as string);

  console.log(
    `${args.dryRun ? "[dry-run] would remove" : "removing"} ${targets.length} record(s):`,
  );
  for (const t of targets) console.log(`  ${t.collection}/${t.rkey}`);
  if (args.dryRun) return;

  const BATCH = 20;
  for (let i = 0; i < targets.length; i += BATCH) {
    await agent.com.atproto.repo.applyWrites({
      repo: did,
      writes: targets.slice(i, i + BATCH).map((t) => ({
        $type: "com.atproto.repo.applyWrites#delete",
        collection: t.collection,
        rkey: t.rkey,
      })),
    });
  }

  await mkdir("data", { recursive: true });
  await appendFile(
    "data/takedowns.jsonl",
    `${JSON.stringify({
      ts: new Date().toISOString(),
      scope: args.whole ? "case" : "entry",
      entry: args.entry,
      reason: args.reason,
      did,
      removed: targets.map((t) => `${t.collection}/${t.rkey}`),
    })}\n`,
  );

  console.log(
    `done — removed ${targets.length} record(s). Effective on this PDS + the canonical AppView; downstream replicators may retain copies.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
