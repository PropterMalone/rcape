// pattern: Functional Core
// Pulls a CourtListener docket id out of a CLI argument or free @-mention text.
// v1 accepts a CL docket URL or a bare CL docket id only — case-name search is
// deliberately out of scope (it needs CL's search API + disambiguation).

import { COURT_LABELS } from "./courts.js";

// CL internal docket ids are 7-9 digits. Reject values outside the plausible
// range — a non-positive id, or one >= 1e10 (a unix-ms timestamp or other
// garbage that would burn ~17 CL calls on a guaranteed 404).
function inDocketRange(n: number): boolean {
  return Number.isInteger(n) && n > 0 && n < 1e10;
}

// CLI arg: a bare number, or a URL containing /docket/<id>/.
export function parseDocketId(arg: string | undefined): number | null {
  if (!arg) return null;
  if (/^\d+$/.test(arg)) {
    const n = Number(arg);
    return inDocketRange(n) ? n : null;
  }
  const m = arg.match(/docket\/(\d+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return inDocketRange(n) ? n : null;
}

// A docket request needs a real signal, not just any long integer — timestamps,
// ZIPs, phone numbers, and AT-URI rkey digits would otherwise burn ~17 CL calls
// each on a guaranteed 404 (and PER_REQUESTER_CAP=3 lets one user drain the
// 125/day budget in three mentions). "add"/"docket"/"case" near the number.
const DOCKET_KEYWORD = /\b(?:add|docket|case)\b/i;

// A docket *link* — a CL `/docket/<id>/` URL carried in a link facet or written
// in the visible text. The unambiguous, always-trusted signal. Link facets are
// authoritative: Bluesky truncates long URLs in the visible post text
// (".../docket/71795...") while the facet keeps the full URL, so a pasted docket
// link would otherwise parse to a wrong, shorter id. Used both for the mention
// itself and when scanning thread posts — where the bare-number heuristic below
// is deliberately NOT applied (a stray 7-digit run in someone else's ancestor
// post isn't addressed to the bot, and a wrong guess burns ~17 CL calls).
export function parseDocketLink(
  text: string,
  links: readonly string[] = [],
): { docketId: number } | null {
  for (const uri of links) {
    const m = uri.match(/\/docket\/(\d+)/i);
    if (m?.[1]) {
      const n = Number(m[1]);
      if (inDocketRange(n)) return { docketId: n };
    }
  }
  const url = text.match(/\/docket\/(\d+)/i);
  if (url?.[1]) {
    const n = Number(url[1]);
    if (inDocketRange(n)) return { docketId: n };
  }
  return null;
}

// A PACER/federal-court case number: `<office>:<2-digit-year>-<type>-<seq>`,
// e.g. "0:26-cr-00115", "3:26-cv-05763", "1:24-md-03101". A trailing judge-initial
// suffix (…-KMM-DTS) is intentionally excluded — CourtListener indexes the core
// number. This is a strong, precise signal (unlike a guessed caption): the caller
// searches CL by docket number, which resolves a single-docket case to exactly
// one. (Multi-defendant criminal cases share one number across several dockets;
// those still fall to the count≠1 suggest, same as any ambiguous request.)
const CASE_NUMBER = /\b(\d{1,2}:\d{2}-[a-z]{2,3}-\d{3,6})\b/i;
export function parseCaseNumber(text: string): string | null {
  const m = text.match(CASE_NUMBER);
  return m?.[1] ? m[1].toLowerCase() : null;
}

// A bare district-style number with NO office prefix and NO zero-padding, e.g.
// "24-cv-645" — the shape a person types from memory ("No. 24-cv-645 (DLF)").
// `<2-4-digit year>-<type>-<1-6-digit seq>`, type ∈ the federal docket codes.
// Word-boundaried so it can't match inside a larger token; the negative
// lookbehind `(?<![:\d])` rejects the unprefixed tail of an office-prefixed
// number (the "24-cv-00645" inside "1:24-cv-00645") and the trailing-digit part
// of a version like "v1.18.0". A bare number is globally ambiguous (CL returns
// many) — the caller's count===1 gate handles that — but parsing it stops a real
// case number from falling into the caption name-guess path.
const BARE_CASE_NUMBER =
  /(?<![:\d])\b(\d{2,4}-(?:cv|cr|md|mc|mj|bk)-\d{1,6})\b/i;

// Split free text (or a Bluebook label) into lowercase alphanumeric tokens.
// Used by both sides of the court reverse-lookup so "Bankr. D. Conn." and a
// label normalize identically — every "." / space / the lone U+2019 apostrophe
// in "Op. Att'y Gen." is a token separator.
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// Each court id paired with its tokenized Bluebook label, computed once. Single-
// token labels (e.g. "BIA", "OLC") are dropped: a lone common word would false-
// match prose and waste a CL search, and every district/bankruptcy designation
// is ≥2 tokens, so coverage is unaffected.
const COURT_TOKENS: ReadonlyArray<readonly [string, readonly string[]]> =
  Object.entries(COURT_LABELS)
    .map(([id, label]) => [id, tokenize(label)] as const)
    .filter(([, toks]) => toks.length >= 2);

// True when `needle` appears as a contiguous run inside `hay`.
function containsRun(
  hay: readonly string[],
  needle: readonly string[],
): boolean {
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

// Resolve a CourtListener court id from a free-text court designation by reverse-
// matching the Bluebook labels in COURT_LABELS. A label matches when its token
// run appears contiguously in the text; the LONGEST matching label wins, so
// "Bankr. D. Conn." resolves to ctb, not the ctd substring "D. Conn.". Null when
// no ≥2-token label matches. A miss is low-risk: parseCourt only guards/scopes a
// docket-number search (count≠1 → suggest), never a wrong provision.
export function parseCourt(text: string): string | null {
  const toks = tokenize(text);
  let bestId: string | null = null;
  let bestLen = 0;
  for (const [id, labelToks] of COURT_TOKENS) {
    if (labelToks.length > bestLen && containsRun(toks, labelToks)) {
      bestId = id;
      bestLen = labelToks.length;
    }
  }
  return bestId;
}

// A bankruptcy/adversary case number: `<2-digit-year>-<4-5-digit seq>`, e.g.
// "22-20743", "22-02014". Any trailing judge/division suffix (…-jjt) falls
// outside the \b-bounded capture. Unlike the district format it has no self-
// validating structure, so a bare match is trusted ONLY alongside a parseable
// court — see parseCaseRef.
const BK_NUMBER = /\b(\d{2}-\d{4,5})\b/;

// The precise docket-request signal: a case number plus, where needed, the court
// that scopes the CourtListener search.
//   - District/appellate numbers ("3:26-cv-05763") are globally near-unique and
//     pass through UNSCOPED (courtId null) — byte-identical to the prior path.
//   - Bankruptcy numbers ("22-20743") collide across courts, so they resolve only
//     when a court is also named; that court both guards against false positives
//     (dates, page ranges, stray "NN-NNNNN" runs) and scopes the search to one.
// Null when no usable case reference is present (caller falls through to Gemini).
export function parseCaseRef(
  text: string,
): { caseNumber: string; courtId: string | null } | null {
  const district = parseCaseNumber(text);
  if (district) return { caseNumber: district, courtId: null };
  // A bare unprefixed district number ("24-cv-645"): unscoped, same as the
  // office-prefixed form. We don't derive a court from a trailing judge
  // parenthetical ("(DLF)") — initials don't map to a court reliably.
  const bare = text.match(BARE_CASE_NUMBER);
  if (bare?.[1]) return { caseNumber: bare[1].toLowerCase(), courtId: null };
  const bk = text.match(BK_NUMBER);
  if (bk?.[1]) {
    const courtId = parseCourt(text);
    if (courtId) return { caseNumber: bk[1], courtId };
  }
  return null;
}

// Free mention text (e.g. "@ape.rcape.org please add
// courtlistener.com/docket/69777799/..."). Prefer a docket link (always trusted);
// otherwise fall back to a standalone 7+ digit run ONLY when a docket keyword is
// present (CL internal docket ids are 7-9 digits).
export function parseMention(
  text: string,
  links: readonly string[] = [],
): { docketId: number } | { kind: "no-docket" } {
  const link = parseDocketLink(text, links);
  if (link) return link;
  if (DOCKET_KEYWORD.test(text)) {
    const bare = text.match(/(?<!\d)(\d{7,})(?!\d)/);
    if (bare?.[1]) {
      const n = Number(bare[1]);
      if (inDocketRange(n)) return { docketId: n };
    }
  }
  return { kind: "no-docket" };
}
