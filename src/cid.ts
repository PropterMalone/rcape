// pattern: Functional Core
// Content identifier for raw bytes (CIDv1, sha2-256, raw codec). Used for the
// hash+link tamper-evidence model: we hash a document's bytes and record the
// CID without hosting the bytes.

import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";

export async function cidForBytes(bytes: Uint8Array): Promise<string> {
  const digest = await sha256.digest(bytes);
  return CID.create(1, raw.code, digest).toString();
}
