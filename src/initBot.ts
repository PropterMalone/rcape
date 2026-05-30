// pattern: Imperative Shell
// One-off: mint the main R.C. Ape "Librarian" bot account (the account that
// receives @-mentions), point its handle DNS at the new DID, and set the
// Librarian profile + a pinned intro post. Re-runnable: if RCAPE_BOT_DID and
// RCAPE_BOT_PASSWORD are already set, it reuses them (skips account creation)
// and just refreshes DNS + profile. Run: `npm run bot:init`.

import { fileURLToPath } from "node:url";
import { CaseRepo } from "./caseRepo.js";
import { BOT_SELF_LABEL, truncate } from "./companionPost.js";
import { upsertAtprotoTxt } from "./dns.js";
import { createCaseAccount, generatePassword } from "./provision.js";

const PROFILE = "app.bsky.actor.profile";
const POST = "app.bsky.feed.post";

const INTRO = truncate(
  "Ook. I am the Librarian of R.C. Ape. Mention me with a CourtListener docket — a link or its id — and I'll shelve that federal case here as its own archive: every filing, signed and in order. Unofficial; source: CourtListener.",
  300,
);

const BIO = truncate(
  "Unofficial: I mirror U.S. federal court dockets as native AT Protocol repos. Mention me with a CourtListener docket and I provision that case, filing by filing — a Pratchett-Librarian for the public record. Tended by @proptermalone. Source: CourtListener.",
  256,
);

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not set`);
  return v;
}

async function main(): Promise<void> {
  const host = process.env.PDS_HOSTNAME;
  const handle = process.env.RCAPE_BOT_HANDLE ?? "ape.rcape.org";
  const domain = process.env.RCAPE_HANDLE_DOMAIN ?? "rcape.org";
  const cfToken = requireEnv("CLOUDFLARE_API_TOKEN");
  const zoneId = requireEnv("CLOUDFLARE_ZONE_ID");

  const existingDid = process.env.RCAPE_BOT_DID;
  const existingPw = process.env.RCAPE_BOT_PASSWORD;

  let did: string;
  let password: string;
  let minted = false;
  if (existingDid && existingPw) {
    console.log(`Reusing existing bot account ${existingDid}.`);
    did = existingDid;
    password = existingPw;
  } else {
    const adminPassword = requireEnv("PDS_ADMIN_PASSWORD");
    password = existingPw ?? generatePassword();
    console.log(`Minting @${handle}…`);
    const account = await createCaseAccount({
      host,
      adminPassword,
      handle,
      email: `bot@${domain}`,
      password,
    });
    did = account.did;
    minted = true;
    console.log(`  did: ${did}`);
  }

  const dns = await upsertAtprotoTxt(handle, did, { zoneId, token: cfToken });
  console.log(
    `  _atproto.${handle} TXT ${dns.created ? "created" : "updated"}`,
  );

  const repo = await CaseRepo.login({ host, identifier: did, password });
  const now = new Date().toISOString();
  const seed = await repo.createRecord(POST, {
    $type: POST,
    text: INTRO,
    createdAt: now,
    labels: BOT_SELF_LABEL,
  });
  await repo.putRecord(PROFILE, "self", {
    $type: PROFILE,
    displayName: "R.C. Ape — the Librarian",
    description: BIO,
    labels: BOT_SELF_LABEL,
    pinnedPost: { uri: seed.uri, cid: seed.cid },
    createdAt: now,
  });
  console.log("  profile + pinned intro set");

  if (minted) {
    console.log("\nAdd these to .env (the password is shown once):");
    console.log(`RCAPE_BOT_DID=${did}`);
    console.log(`RCAPE_BOT_PASSWORD=${password}`);
  }
  console.log(
    `\ndone — @${handle} is live. Set RCAPE_OWNER_HANDLE, then run: npm run bot`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
