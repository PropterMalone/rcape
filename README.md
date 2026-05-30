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

## The name

**RC Ape** is an anagram of **RECAP**, personified as a [Terry Pratchett *Librarian*](https://en.wikipedia.org/wiki/Librarian_(Discworld))-style retrieval ape — a dignified guardian who fetches and protects the record. Built by [@proptermalone](https://bsky.app/profile/proptermalone.bsky.social).

## Run your own instance

Requirements: Node 22+, a self-hosted [atproto PDS](https://github.com/bluesky-social/pds), a (free) CourtListener API token, and a domain on a DNS provider you control.

```sh
npm install
cp .env.example .env        # fill in token, PDS host, case account creds
npm run build:repo          # pull a docket from CourtListener -> signed CAR + web view
npm run verify:repo         # round-trip the CAR (lists records = the browse view)
npm run publish:records     # write the org.rcape.* records to the live PDS
npm run fire -- --dry-run   # preview the profile + posts
npm run fire                # publish profile + pinned seed + backdated doc-posts
npm run takedown -- --entry <rkey> --reason "<basis>"   # remove a filing + its post
```

`npm run validate` runs Biome, TypeScript, Vitest, and Knip.

## Status

Proof of concept — one case live. Next: the **R.C. Ape** by-request bot (mention it with a case → it provisions a per-case repo) and a watched-case auto-monitor (polls for new filings, appends them, and honors upstream seals).

## Disclaimer

Unofficial. Mirrors public court records from CourtListener; not affiliated with any court or with Free Law Project. Not legal advice.

## License

MIT — see [LICENSE](./LICENSE).
