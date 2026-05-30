// pattern: Imperative Shell
// Populates the live PDS case repo with the org.rcape.* records from a built CAR.
// Records are non-social (the Bluesky AppView ignores unknown collections); they
// make "browse via listRecords" work on the live repo. Companion social posts
// are NOT handled here — those are staged + published separately, on review.

import { readFile } from "node:fs/promises";
import { MemoryBlockstore, Repo, readCarWithRoot } from "@atproto/repo";
import { CaseRepo, type CreateRow } from "./caseRepo.js";

async function loadRcapeRecords(carPath: string): Promise<CreateRow[]> {
  const bytes = new Uint8Array(await readFile(carPath));
  const { root, blocks } = await readCarWithRoot(bytes);
  const repo = await Repo.load(new MemoryBlockstore(blocks), root);
  const out: CreateRow[] = [];
  for await (const e of repo.walkRecords()) {
    if (!e.collection.startsWith("org.rcape.")) continue;
    out.push({
      collection: e.collection,
      rkey: e.rkey,
      value: e.record as Record<string, unknown>,
    });
  }
  return out;
}

async function main(): Promise<void> {
  const identifier = process.env.RCAPE_CASE_DID;
  const password = process.env.RCAPE_CASE_PASSWORD;
  if (!identifier || !password) {
    throw new Error("RCAPE_CASE_DID / RCAPE_CASE_PASSWORD not set");
  }
  const carPath = process.argv[2] ?? "data/69777799.car";

  const repo = await CaseRepo.login({
    host: process.env.PDS_HOSTNAME,
    identifier,
    password,
  });

  const records = await loadRcapeRecords(carPath);
  console.log(`loading ${records.length} records into ${repo.did}`);
  await repo.applyCreates(records);
  console.log("done");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
