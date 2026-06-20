# RC Ape

**Court dockets as AT Protocol repos — follow and browse a federal case on Bluesky.**

RC Ape mirrors public U.S. federal court dockets (via [CourtListener](https://www.courtlistener.com/)/RECAP) into **one AT Protocol repo per case**, hosted on a self-hosted, federating PDS. Each filing becomes a signed, content-addressed record, so you can:

- **Follow the case** — every filing is published as a post (backdated to its real filing date), so the account's timeline *is* the docket.
- **Browse the case** — `com.atproto.repo.listRecords` over the repo returns the full docket in order; no separate database.

Accounts are labeled with the official atproto `bot` self-label and are **unofficial mirrors** — the source of truth is CourtListener.

**Live demo:** [`@abrego-garcia.rcape.org`](https://bsky.app/profile/abrego-garcia.rcape.org) — *Abrego Garcia v. Noem* (8:25-cv-00951, D. Md.).

## How it works

- **A case = one repo.** Records use the `org.rcape.*` lexicons: `docket` (a `self` record with case metadata), `docketEntry` (one per filing, `tid`-keyed, in docket order), and `party`.
- **hash + link provenance.** Documents are referenced by their public CourtListener storage URL plus a content CID (CIDv1, sha2-256). RC Ape records the hash for tamper-evidence without re-hosting the bytes.
- **Companion posts.** Each docket entry also gets an `app.bsky.feed.post` (backdated to the filing date), linked back onto the entry via a `docPost` strong reference — so a takedown removes the post along with the record.
- **Self-hosted + federating.** Runs the official `bluesky-social/pds` behind a Cloudflare Tunnel; `requestCrawl` federates it to the Bluesky relay so the account is discoverable and followable from any client.
- **Takedown + honor-upstream.** No proactive redaction (court records are already public). Instead: a takedown lever (entry- or case-level, with a required reason and an append-only audit log) and a policy of being *no more permissive than the source* — sealed/removed-upstream filings are retracted.
- **Watchlist sweeper (optional, off by default).** Beyond by-request, RC Ape can proactively shelve cases getting media attention. Point `RCAPE_WATCHLIST_URI` at a curated, consent-based Bluesky list (`app.bsky.graph.list`) of legal journalists / court-watchers; the bot reads that list's feed and auto-provisions a docket once enough distinct members share a CourtListener `/docket/` link. Only *direct* docket links count (no caption guessing), reading the list costs no CourtListener quota, and provisioning is budget-gated + capped so a trending case never starves a by-request user. See the `RCAPE_WATCHLIST_*` vars in `.env.example`.

## The name

**RC Ape** is an anagram of **RECAP**, personified as a [Terry Pratchett *Librarian*](https://en.wikipedia.org/wiki/Librarian_(Discworld))-style retrieval ape — a dignified guardian who fetches and protects the record. Built by [@proptermalone](https://bsky.app/profile/proptermalone.bsky.social).

## Run your own instance

Requirements: Node 22+, a self-hosted [atproto PDS](https://github.com/bluesky-social/pds), a (free) CourtListener API token, and a domain on a DNS provider you control.

```sh
npm install
cp .env.example .env        # fill in CL token, PDS host + admin password, handle domain, Cloudflare token
```

**Provision a case end-to-end** (mint account -> DNS -> records -> backdated posts), deduped and quota-aware:

```sh
npm run provision -- <courtlistener-docket-id|docket-url>            # do it
npm run provision -- <docket-id> --dry-run                          # preview only (still queries CourtListener, so it burns quota)
npm run provision -- <docket-id> --force                            # re-provision (mints a second account; the prior is archived in the ledger)
```

Provisioned cases and their per-case credentials are recorded in `data/ledger.json`, which also tracks the shared CourtListener daily-quota counter (125/day).

**Or run the lower-level steps by hand** (operate a single account set via `RCAPE_CASE_DID`/`RCAPE_CASE_PASSWORD`):

```sh
npm run build:repo          # pull a docket from CourtListener -> signed CAR + web view
npm run verify:repo         # round-trip the CAR (lists records = the browse view)
npm run publish:records     # write the org.rcape.* records to the live PDS
npm run fire -- --dry-run   # preview the profile + posts
npm run fire                # publish profile + pinned seed + backdated doc-posts
npm run takedown -- --entry <rkey> --reason "<basis>"   # remove a filing + its post
```

`npm run validate` runs Biome, TypeScript, Vitest, and Knip.

## Status

The **R.C. Ape** by-request bot is shipped: mention [@ape.rcape.org](https://bsky.app/profile/ape.rcape.org) with a CourtListener docket (a link or its id) and it provisions a per-case repo, replying when the case is shelved. Requests are admitted from accounts [@proptermalone](https://bsky.app/profile/proptermalone.bsky.social) follows or who follow them, and drained under the shared CourtListener daily budget.

Roadmap:

- **Watched-case auto-monitor** — polls provisioned cases for new filings, appends them, and honors upstream seals.
- **Late-document backfill** — when an entry is shelved before its document is captured in RECAP (no `filepath_local`, so the companion post links to the CL docket page rather than a PDF), re-capture the document once RECAP has it. The new-entry monitor above won't cover this: a later document on an *already-shelved* entry doesn't advance the case's `highWater`, so a distinct re-scan is needed. Enabler: stamp entries shelved without a document (or with `is_available: false`) as "pending capture" so the re-scan knows which to revisit. Until then, the post's link to the live CL docket page self-heals for human readers.

## Disclaimer

Unofficial. Mirrors public court records from CourtListener; not affiliated with any court or with Free Law Project. Not legal advice.

## License

MIT — see [LICENSE](./LICENSE).
