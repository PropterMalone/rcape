// pattern: Functional Core
// Pulls a CourtListener docket id out of a CLI argument or free @-mention text.
// v1 accepts a CL docket URL or a bare CL docket id only — case-name search is
// deliberately out of scope (it needs CL's search API + disambiguation).

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
