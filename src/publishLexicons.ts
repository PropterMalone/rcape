// pattern: Imperative Shell
// One-off: publish the org.rcape.* lexicons to the AT Protocol network so they're
// resolvable + verifiable network-wide (other AppViews can then natively render
// docket records). Two parts:
//   1. A com.atproto.lexicon.schema record per lexicon, in the publisher's repo,
//      rkey = the NSID (key: "nsid"), value = the lexicon doc + $type.
//   2. A `_lexicon.<authority>` DNS TXT (did=<publisher>) so resolvers find them.
// Idempotent: putRecord overwrites at the fixed NSID rkey; the DNS upsert PUTs an
// existing record. Run: `npm run lex:publish`. Publisher defaults to the bot
// account (RCAPE_BOT_DID), overridable via RCAPE_LEXICON_PUBLISHER_DID /
// RCAPE_LEXICON_PUBLISHER_PASSWORD if a dedicated authority account is preferred.

import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { CaseRepo } from "./caseRepo.js";
import { upsertLexiconTxt } from "./dns.js";
import {
  LEXICON_SCHEMA_COLLECTION,
  type LexiconDoc,
  buildSchemaRecord,
  lexiconAuthorityDomain,
} from "./lexiconSchema.js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not set`);
  return v;
}

async function loadLexiconDocs(dir: string): Promise<LexiconDoc[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  const docs: LexiconDoc[] = [];
  for (const f of files.sort()) {
    const doc = JSON.parse(await readFile(`${dir}/${f}`, "utf8")) as LexiconDoc;
    if (!doc.id || typeof doc.lexicon !== "number" || !doc.defs) {
      throw new Error(`${f}: not a lexicon doc (need lexicon/id/defs)`);
    }
    docs.push(doc);
  }
  return docs;
}

async function main(): Promise<void> {
  const host = process.env.PDS_HOSTNAME;
  const cfToken = requireEnv("CLOUDFLARE_API_TOKEN");
  const zoneId = requireEnv("CLOUDFLARE_ZONE_ID");
  // Publisher: a dedicated authority account if configured, else the bot itself.
  const did =
    process.env.RCAPE_LEXICON_PUBLISHER_DID ?? requireEnv("RCAPE_BOT_DID");
  const password =
    process.env.RCAPE_LEXICON_PUBLISHER_PASSWORD ??
    requireEnv("RCAPE_BOT_PASSWORD");

  const dir = fileURLToPath(new URL("../lexicons/org/rcape", import.meta.url));
  const docs = await loadLexiconDocs(dir);
  console.log(`Publishing ${docs.length} lexicon(s) as ${did}:`);

  // All NSIDs must share one authority domain (they do: org.rcape.*) — the single
  // _lexicon.<authority> TXT covers them all.
  const authorities = new Set(docs.map((d) => lexiconAuthorityDomain(d.id)));
  if (authorities.size !== 1) {
    throw new Error(
      `lexicons span multiple authorities (${[...authorities].join(", ")}); one _lexicon TXT can't cover them`,
    );
  }
  const authority = [...authorities][0] as string;

  const repo = await CaseRepo.login({ host, identifier: did, password });
  for (const doc of docs) {
    await repo.putRecord(
      LEXICON_SCHEMA_COLLECTION,
      doc.id,
      buildSchemaRecord(doc),
    );
    console.log(
      `  ✓ ${doc.id}  (at://${did}/${LEXICON_SCHEMA_COLLECTION}/${doc.id})`,
    );
  }

  const dns = await upsertLexiconTxt(authority, did, {
    zoneId,
    token: cfToken,
  });
  console.log(
    `  ✓ _lexicon.${authority} TXT ${dns.created ? "created" : "updated"} → did=${did}`,
  );
  console.log(
    `\nVerify: dig +short TXT _lexicon.${authority}  (expect "did=${did}")`,
  );
}

main().catch((e) => {
  console.error("publish-lexicons failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
