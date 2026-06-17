// pattern: Imperative Shell
// Orchestrator: pull a docket from CourtListener, map to RC Ape records, hash a
// bounded document subset, build the signed repo + CAR, and emit a web view.

import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { FetchCheckpoint } from "./caseCache.js";
import { CourtListenerClient, ThrottledError } from "./courtlistener.js";
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

// Keep the first occurrence of each `id` — closes the cursor-boundary duplicate
// window when entry/party pages accumulate across resumed fetch windows.
function dedupeById<T extends { id: number }>(items: readonly T[]): T[] {
  const seen = new Set<number>();
  const out: T[] = [];
  for (const it of items) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    out.push(it);
  }
  return out;
}

// Pull a docket from CourtListener and map it to RC Ape lexicon records. Shared
// by the offline CAR builder (below) and the on-demand provisioner. Throws if
// the docket does not exist (CourtListener 404) — callers rely on that to
// validate a case before provisioning. An optional client tracks the CL request
// count for quota accounting.
//
// RESUMABLE: pass `resume.checkpoint` to continue a fetch interrupted by a rate
// throttle, and `resume.onProgress` to persist progress after each page. The
// fetch advances the checkpoint phase by phase (docket → entries → parties);
// a ThrottledError propagates AFTER the last good page is checkpointed, so the
// next window resumes from the cursor instead of restarting at page 1. Hashing +
// mapping are terminal (run once, only when all CL pages are in) so a big docket
// completes across windows under a dribbled rate limit.
export async function fetchAndMapCase(
  opts: MapOptions,
  client: CourtListenerClient = new CourtListenerClient(opts.token),
  resume?: {
    checkpoint?: FetchCheckpoint;
    onProgress?: (cp: FetchCheckpoint) => Promise<void>;
  },
): Promise<MappedCase> {
  const now = new Date().toISOString();
  const cp: FetchCheckpoint = resume?.checkpoint ?? {
    savedAt: now,
    entries: [],
    entriesNext: null,
    entriesStarted: false,
    parties: [],
    partiesNext: null,
    partiesStarted: false,
  };
  const persist = async (): Promise<void> => {
    if (resume?.onProgress) await resume.onProgress(cp);
  };

  console.log(`Fetching docket ${opts.docketId}…`);
  if (!cp.docket) {
    cp.docket = await client.getDocket(opts.docketId);
    await persist();
  }
  const docket = cp.docket;

  // Entries — resumable. MAX_PAGES only chunks the loop; completion (next===null)
  // or a ThrottledError ends it. Every page is checkpointed, so a throttle
  // mid-pagination leaves durable progress and the next window resumes the tail.
  while (!(cp.entriesStarted && cp.entriesNext === null)) {
    const { next } = await client.fetchDocketEntries(opts.docketId, {
      resumeFrom: cp.entriesStarted ? cp.entriesNext : undefined,
      onPage: async (page, nextCursor) => {
        cp.entries.push(...page);
        cp.entriesNext = nextCursor;
        cp.entriesStarted = true;
        await persist();
      },
    });
    cp.entriesStarted = true;
    cp.entriesNext = next;
    await persist();
  }
  console.log(`  ${cp.entries.length} entries`);

  // Parties — resumable. A ThrottledError MUST propagate (resume next window), not
  // be swallowed: swallowing it would "complete" the case with zero parties. Only
  // genuine non-throttle failures are tolerated (parties stay as-fetched/empty).
  try {
    while (!(cp.partiesStarted && cp.partiesNext === null)) {
      const { next } = await client.fetchParties(opts.docketId, {
        resumeFrom: cp.partiesStarted ? cp.partiesNext : undefined,
        onPage: async (page, nextCursor) => {
          cp.parties.push(...page);
          cp.partiesNext = nextCursor;
          cp.partiesStarted = true;
          await persist();
        },
      });
      cp.partiesStarted = true;
      cp.partiesNext = next;
      await persist();
    }
  } catch (e) {
    if (e instanceof ThrottledError) throw e;
    console.warn("parties fetch failed:", (e as Error).message);
  }

  // Terminal: all CL pages are in. Hash (off-quota storage host) + map run once.
  const source = makeSource(docket, now);
  const entriesRaw = dedupeById(cp.entries);
  const entriesToHash = entriesRaw.slice(0, opts.hashFirstNEntries);
  const urls = entriesToHash
    .flatMap((e) => e.recap_documents ?? [])
    .filter((d) => d.filepath_local)
    .map((d) => storageUrl(d.filepath_local as string));
  console.log(
    `Hashing ${urls.length} documents (first ${opts.hashFirstNEntries} entries)…`,
  );
  const cids = await hashDocuments(urls);
  console.log(`  ${cids.size} hashed`);

  const parties: PartyRecord[] = dedupeById(cp.parties).map((p) =>
    mapParty(p, source, now),
  );
  console.log(`  ${parties.length} parties`);

  const docketRecord = mapDocket(docket, now, now);
  const entryRecords: DocketEntryRecord[] = entriesRaw.map((e) =>
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
