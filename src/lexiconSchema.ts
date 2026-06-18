// pattern: Functional Core
// Pure helpers for publishing org.rcape.* lexicons as com.atproto.lexicon.schema
// records (see publishLexicons.ts for the I/O). A schema record IS the lexicon
// document with the record $type added; its rkey is the NSID (key: "nsid"), and
// the DNS authority is the NSID authority reversed to a domain.

// The on-disk lexicon document shape (lexicons/org/rcape/*.json).
export interface LexiconDoc {
  lexicon: number;
  id: string; // the NSID, e.g. "org.rcape.docket"
  defs: Record<string, unknown>;
}

export const LEXICON_SCHEMA_COLLECTION = "com.atproto.lexicon.schema";

// The record value to publish: the lexicon doc verbatim, tagged with the schema
// record $type. Stored at rkey = doc.id (the NSID).
export function buildSchemaRecord(doc: LexiconDoc): Record<string, unknown> {
  return { $type: LEXICON_SCHEMA_COLLECTION, ...doc };
}

// The DNS authority domain for an NSID: drop the final segment (the name) and
// reverse the remaining authority segments into a domain. `org.rcape.docket` →
// authority `org.rcape` → `rcape.org`. Resolvers read `_lexicon.<this>` TXT to
// find the publishing DID. Throws on an NSID too short to have an authority.
export function lexiconAuthorityDomain(nsid: string): string {
  const segments = nsid.split(".");
  if (segments.length < 3) {
    throw new Error(`NSID "${nsid}" has no authority (need ≥3 segments)`);
  }
  const authority = segments.slice(0, -1); // drop the name segment
  return authority.reverse().join(".");
}
