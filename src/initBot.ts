// pattern: Imperative Shell
// One-off: mint the main R.C. Ape "Librarian" bot account (the account that
// receives @-mentions), point its handle DNS at the new DID, and set the
// Librarian profile + a pinned intro post. Re-runnable: if RCAPE_BOT_DID and
// RCAPE_BOT_PASSWORD are already set, it reuses them (skips account creation)
// and just refreshes DNS + profile. Run: `npm run bot:init`.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { CaseRepo } from "./caseRepo.js";
import { BOT_SELF_LABEL, truncate } from "./companionPost.js";
import { upsertAtprotoTxt } from "./dns.js";
import { createCaseAccount, generatePassword } from "./provision.js";

const PROFILE = "app.bsky.actor.profile";
const POST = "app.bsky.feed.post";

const INTRO = truncate(
  "Ook. I am the Librarian of R.C. Ape. Mention me with a CourtListener docket (a link or its id) and I'll shelve that federal case here as its own archive: every filing, signed and in order. Unofficial; source: CourtListener.",
  300,
);

const BIO = truncate(
  "I mirror U.S. federal court dockets from RECAP as native AT Protocol repos. Mention me with a CourtListener docket and I shelve it. How it works: https://gist.github.com/PropterMalone/579b9d77577fe45c3cb540905ba7d6ec Tended by @proptermalone.",
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

  // Upload the seal avatar if present; mint still succeeds without it.
  let avatar: unknown;
  try {
    const path = fileURLToPath(
      new URL("../assets/avatar.png", import.meta.url),
    );
    avatar = await repo.uploadBlob(
      new Uint8Array(await readFile(path)),
      "image/png",
    );
    console.log("  avatar uploaded");
  } catch (e) {
    console.warn(`  no avatar set: ${e instanceof Error ? e.message : e}`);
  }

  // On a re-run the account already has a pinned intro; posting a fresh one each
  // time would litter the timeline with duplicate intros. Reuse the existing
  // pinned post if present, and only mint a new intro on first init.
  let pinned: { uri: string; cid: string } | undefined;
  try {
    const profile = (await repo.getRecord(PROFILE, "self")) as {
      pinnedPost?: { uri: string; cid: string };
    };
    pinned = profile.pinnedPost;
  } catch {
    // No profile yet (first init): pinned stays undefined → post a fresh intro.
  }
  if (pinned) {
    console.warn(
      "  profile already has a pinned intro — reusing it (not posting a duplicate)",
    );
  } else {
    const seed = await repo.createRecord(POST, {
      $type: POST,
      text: INTRO,
      createdAt: now,
      labels: BOT_SELF_LABEL,
    });
    pinned = { uri: seed.uri, cid: seed.cid };
  }
  await repo.putRecord(PROFILE, "self", {
    $type: PROFILE,
    displayName: "R.C. Ape, PhD, MLIS, LL.M.",
    description: BIO,
    ...(avatar ? { avatar } : {}),
    labels: BOT_SELF_LABEL,
    pinnedPost: pinned,
    createdAt: now,
  });
  console.log("  profile + pinned intro set");

  if (minted) {
    // The password is printed once, here, to stdout — which under systemd is
    // captured by journald. If this init ran on a host whose journal is shared
    // or readable by others, rotate the bot password after saving it to .env.
    console.log("\nAdd these to .env (the password is shown once):");
    console.log(`RCAPE_BOT_DID=${did}`);
    console.log(`RCAPE_BOT_PASSWORD=${password}`);
    console.log(
      "\nNOTE: this password was printed to stdout (journald captures it under" +
        " systemd). Rotate it if this host's journal is shared.",
    );
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
