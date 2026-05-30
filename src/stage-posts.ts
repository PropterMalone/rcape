// pattern: Imperative Shell
// Stages (does NOT publish) the social layer for review: a proposed profile and
// companion app.bsky.feed.post records for the most recent N docket entries.
// Output: data/staged-posts.json. Publishing is a separate, explicit step.

import { readFile, writeFile } from "node:fs/promises";
import { MemoryBlockstore, Repo, readCarWithRoot } from "@atproto/repo";
import { entryToPost } from "./companionPost.js";
import type { DocketEntryRecord, DocketRecord } from "./map.js";

async function main(): Promise<void> {
  const carPath = process.argv[2] ?? "data/69777799.car";
  const n = Number(process.env.CRANCH_BACKFILL_N ?? "10");
  const bytes = new Uint8Array(await readFile(carPath));
  const { root, blocks } = await readCarWithRoot(bytes);
  const repo = await Repo.load(new MemoryBlockstore(blocks), root);

  let docket: DocketRecord | undefined;
  const entries: DocketEntryRecord[] = [];
  for await (const e of repo.walkRecords()) {
    if (e.collection === "com.proptermalone.cranch.docket") {
      docket = e.record as unknown as DocketRecord;
    } else if (e.collection === "com.proptermalone.cranch.docketEntry") {
      entries.push(e.record as unknown as DocketEntryRecord);
    }
  }
  if (!docket) throw new Error("no docket record in CAR");

  entries.sort((a, b) =>
    (a.recapSequenceNumber ?? "").localeCompare(b.recapSequenceNumber ?? ""),
  );
  const recent = entries.slice(-n);
  const caseUrl = docket.source.url ?? "https://www.courtlistener.com/";
  const posts = recent.map((e) =>
    entryToPost(e, docket.caseName, caseUrl, e.dateFiled),
  );

  const profile = {
    $type: "app.bsky.actor.profile",
    displayName: docket.caseName,
    description: `Unofficial auto-mirror of the docket for ${docket.docketNumber} (${docket.court}), Judge ${docket.assignedJudge}. Each filing is a signed, content-addressed record — follow for new filings; the full docket lives on this repo. Source: CourtListener.`,
  };

  await writeFile(
    "data/staged-posts.json",
    JSON.stringify({ profile, posts }, null, 2),
  );
  console.log(
    `staged ${posts.length} companion posts + profile -> data/staged-posts.json`,
  );
  console.log("\nPROPOSED PROFILE");
  console.log("  displayName:", profile.displayName);
  console.log("  description:", profile.description);
  console.log("\nSAMPLE POSTS (most recent 3):");
  for (const p of posts.slice(-3)) console.log("  •", p.text);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
