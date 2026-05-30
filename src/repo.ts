// pattern: Imperative Shell
// Builds a signed, content-addressed atproto repo from a set of records and
// exports it as a CAR file. Offline artifact: uses an ephemeral did:key so the
// commit is self-verifying. The live PDS account gets its own did:plc.

import { TID } from "@atproto/common";
import { Secp256k1Keypair } from "@atproto/crypto";
import {
  MemoryBlockstore,
  type RecordCreateOp,
  Repo,
  WriteOpAction,
  blocksToCarFile,
} from "@atproto/repo";

export interface RecordInput {
  collection: string;
  rkey: string;
  record: Record<string, unknown>;
}

interface BuiltRepo {
  did: string;
  commitCid: string;
  car: Uint8Array;
  uris: string[];
  recordCount: number;
}

export function nextRkey(): string {
  return TID.nextStr();
}

// CBOR/lexicon encoding rejects `undefined`; drop those keys recursively.
export function prune<T>(v: T): T {
  if (Array.isArray(v)) return v.map((x) => prune(x)) as unknown as T;
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val !== undefined) o[k] = prune(val);
    }
    return o as unknown as T;
  }
  return v;
}

export async function buildRepoCar(records: RecordInput[]): Promise<BuiltRepo> {
  const keypair = await Secp256k1Keypair.create({ exportable: true });
  const did = keypair.did();
  const storage = new MemoryBlockstore();
  const writes: RecordCreateOp[] = records.map((r) => ({
    action: WriteOpAction.Create,
    collection: r.collection,
    rkey: r.rkey,
    record: prune(r.record),
  }));
  const commit = await Repo.formatInitCommit(storage, did, keypair, writes);
  const car = await blocksToCarFile(commit.cid, commit.newBlocks);
  const uris = records.map((r) => `at://${did}/${r.collection}/${r.rkey}`);
  return {
    did,
    commitCid: commit.cid.toString(),
    car,
    uris,
    recordCount: records.length,
  };
}
