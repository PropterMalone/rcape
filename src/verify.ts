// pattern: Imperative Shell
// Round-trips a Cranch CAR file: loads it as an atproto repo and lists records
// by collection — demonstrating that "browse the case" is just listRecords over
// the repo, with no separate database.

import { readFile } from "node:fs/promises";
import { MemoryBlockstore, Repo, readCarWithRoot } from "@atproto/repo";

interface EntryView {
  entryNumber?: number;
  description?: string;
}

async function main(): Promise<void> {
  const path = process.argv[2] ?? "data/69777799.car";
  const bytes = new Uint8Array(await readFile(path));
  const { root, blocks } = await readCarWithRoot(bytes);
  const storage = new MemoryBlockstore(blocks);
  const repo = await Repo.load(storage, root);
  const contents = (await repo.getContents()) as Record<
    string,
    Record<string, unknown>
  >;

  console.log(`CAR:         ${path} (${bytes.length} bytes)`);
  console.log(`Root/commit: ${root.toString()}`);
  console.log(`Repo DID:    ${repo.did}`);
  console.log("Collections (browse via listRecords):");
  let total = 0;
  for (const [collection, recs] of Object.entries(contents)) {
    const n = Object.keys(recs).length;
    total += n;
    console.log(`  ${collection}: ${n}`);
  }
  console.log(`Total records: ${total}`);

  const entries = contents["com.proptermalone.cranch.docketEntry"] ?? {};
  console.log("First entries in docket order:");
  for (const rkey of Object.keys(entries).slice(0, 3)) {
    const r = entries[rkey] as EntryView;
    console.log(
      `  #${r.entryNumber ?? "·"}: ${(r.description ?? "").slice(0, 64)}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
