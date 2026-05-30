// pattern: Imperative Shell
// Populates the live PDS case repo with the cranch.* records from a built CAR.
// Records are non-social (the Bluesky AppView ignores unknown collections); they
// make "browse via listRecords" work on the live repo. Companion social posts
// are NOT handled here — those are staged + published separately, on review.

import { readFile } from "node:fs/promises";
import { AtpAgent } from "@atproto/api";
import { MemoryBlockstore, Repo, readCarWithRoot } from "@atproto/repo";

interface RecordRow {
  collection: string;
  rkey: string;
  value: Record<string, unknown>;
}

async function loadCranchRecords(carPath: string): Promise<RecordRow[]> {
  const bytes = new Uint8Array(await readFile(carPath));
  const { root, blocks } = await readCarWithRoot(bytes);
  const repo = await Repo.load(new MemoryBlockstore(blocks), root);
  const out: RecordRow[] = [];
  for await (const e of repo.walkRecords()) {
    if (!e.collection.startsWith("com.proptermalone.cranch.")) continue;
    out.push({
      collection: e.collection,
      rkey: e.rkey,
      value: e.record as Record<string, unknown>,
    });
  }
  return out;
}

async function main(): Promise<void> {
  const host = process.env.PDS_HOSTNAME ?? "cranch.proptermalone.com";
  const identifier = process.env.CRANCH_CASE_DID;
  const password = process.env.CRANCH_CASE_PASSWORD;
  if (!identifier || !password) {
    throw new Error("CRANCH_CASE_DID / CRANCH_CASE_PASSWORD not set");
  }
  const carPath = process.argv[2] ?? "data/69777799.car";

  const agent = new AtpAgent({ service: `https://${host}` });
  await agent.login({ identifier, password });
  const did = agent.session?.did;
  if (!did) throw new Error("login failed");

  const records = await loadCranchRecords(carPath);
  console.log(`loading ${records.length} records into ${did}`);

  const BATCH = 20;
  for (let i = 0; i < records.length; i += BATCH) {
    const slice = records.slice(i, i + BATCH);
    await agent.com.atproto.repo.applyWrites({
      repo: did,
      writes: slice.map((r) => ({
        $type: "com.atproto.repo.applyWrites#create",
        collection: r.collection,
        rkey: r.rkey,
        value: r.value,
      })),
    });
    console.log(
      `  wrote ${Math.min(i + BATCH, records.length)}/${records.length}`,
    );
  }
  console.log("done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
