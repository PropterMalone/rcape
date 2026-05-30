// pattern: Imperative Shell
// Orchestrator: pull a docket from CourtListener, map to RC Ape records, hash a
// bounded document subset, build the signed repo + CAR, and emit a web view.

import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { CourtListenerClient } from "./courtlistener.js";
import { hashDocuments } from "./hash.js";
import {
  type DocketEntryRecord,
  type DocketRecord,
  type PartyRecord,
  makeSource,
  mapDocket,
  mapEntry,
  mapParty,
  storageUrl,
} from "./map.js";
import { type RecordInput, buildRepoCar, nextRkey } from "./repo.js";
import { renderCaseHtml } from "./webview.js";

const DOCKET_COLLECTION = "org.rcape.docket";
const ENTRY_COLLECTION = "org.rcape.docketEntry";
const PARTY_COLLECTION = "org.rcape.party";

export interface MapOptions {
  docketId: number;
  token: string;
  hashFirstNEntries: number;
}

// build() also writes the offline CAR + HTML artifacts to outDir; the mapper
// (fetchAndMapCase) does no I/O and ignores it, hence the split.
export interface BuildOptions extends MapOptions {
  outDir: string;
}

export interface MappedCase {
  docketRecord: DocketRecord;
  entryRecords: DocketEntryRecord[];
  parties: PartyRecord[];
  records: RecordInput[];
}

// Pull a docket from CourtListener and map it to RC Ape lexicon records. Shared
// by the offline CAR builder (below) and the on-demand provisioner. Throws if
// the docket does not exist (CourtListener 404) — callers rely on that to
// validate a case before provisioning. An optional client lets callers track
// the CL request count for quota accounting.
export async function fetchAndMapCase(
  opts: MapOptions,
  client: CourtListenerClient = new CourtListenerClient(opts.token),
): Promise<MappedCase> {
  const now = new Date().toISOString();

  console.log(`Fetching docket ${opts.docketId}…`);
  const docket = await client.getDocket(opts.docketId);
  const entries = await client.getAllDocketEntries(opts.docketId);
  console.log(`  ${entries.length} entries`);

  const source = makeSource(docket, now);

  const entriesToHash = entries.slice(0, opts.hashFirstNEntries);
  const urls = entriesToHash
    .flatMap((e) => e.recap_documents ?? [])
    .filter((d) => d.filepath_local)
    .map((d) => storageUrl(d.filepath_local as string));
  console.log(
    `Hashing ${urls.length} documents (first ${opts.hashFirstNEntries} entries)…`,
  );
  const cids = await hashDocuments(urls);
  console.log(`  ${cids.size} hashed`);

  let parties: PartyRecord[] = [];
  try {
    const rawParties = await client.getAllParties(opts.docketId);
    parties = rawParties.map((p) => mapParty(p, source, now));
    console.log(`  ${parties.length} parties`);
  } catch (e) {
    console.warn("parties fetch failed:", (e as Error).message);
  }

  const docketRecord = mapDocket(docket, now, now);
  const entryRecords: DocketEntryRecord[] = entries.map((e) =>
    mapEntry(e, source, now, cids),
  );

  const records: RecordInput[] = [
    {
      collection: DOCKET_COLLECTION,
      rkey: "self",
      record: docketRecord as unknown as Record<string, unknown>,
    },
    ...entryRecords.map((er) => ({
      collection: ENTRY_COLLECTION,
      rkey: nextRkey(),
      record: er as unknown as Record<string, unknown>,
    })),
    ...parties.map((pr) => ({
      collection: PARTY_COLLECTION,
      rkey: nextRkey(),
      record: pr as unknown as Record<string, unknown>,
    })),
  ];

  return { docketRecord, entryRecords, parties, records };
}

export async function build(opts: BuildOptions): Promise<void> {
  const { docketRecord, entryRecords, parties, records } =
    await fetchAndMapCase(opts);

  console.log(`Building signed repo with ${records.length} records…`);
  const built = await buildRepoCar(records);

  await mkdir(opts.outDir, { recursive: true });
  const carPath = `${opts.outDir}/${opts.docketId}.car`;
  const htmlPath = `${opts.outDir}/${opts.docketId}.html`;
  await writeFile(carPath, built.car);
  await writeFile(
    htmlPath,
    renderCaseHtml(docketRecord, entryRecords, { did: built.did }),
  );

  console.log("\n=== RC Ape repo built ===");
  console.log(`DID (offline did:key): ${built.did}`);
  console.log(`Commit CID:            ${built.commitCid}`);
  console.log(
    `Records:              ${built.recordCount} (1 docket + ${entryRecords.length} entries + ${parties.length} parties)`,
  );
  console.log(`CAR:                  ${carPath} (${built.car.length} bytes)`);
  console.log(`Web view:             ${htmlPath}`);
  console.log(`Example entry URI:    ${built.uris[1] ?? built.uris[0]}`);
}

async function main(): Promise<void> {
  const token = process.env.COURTLISTENER_API_TOKEN;
  if (!token) throw new Error("COURTLISTENER_API_TOKEN not set");
  const docketId = Number(process.env.RCAPE_DOCKET_ID ?? "69777799");
  const hashN = Number(process.env.RCAPE_HASH_FIRST_N ?? "15");
  await build({ docketId, token, hashFirstNEntries: hashN, outDir: "data" });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
