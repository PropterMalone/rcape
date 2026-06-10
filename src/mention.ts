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

// Free mention text (e.g. "@ape.rcape.org please add
// courtlistener.com/docket/69777799/..."). Prefer a docket URL (always trusted);
// otherwise fall back to a standalone 7+ digit run ONLY when a docket keyword is
// present (CL internal docket ids are 7-9 digits).
export function parseMention(
  text: string,
  links: readonly string[] = [],
): { docketId: number } | { kind: "no-docket" } {
  // Link-facet URLs are authoritative: Bluesky truncates long URLs in the visible
  // post text (".../docket/71795...") while the facet keeps the full URL, so a
  // pasted docket link would otherwise parse to a wrong, shorter id.
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
  if (DOCKET_KEYWORD.test(text)) {
    const bare = text.match(/(?<!\d)(\d{7,})(?!\d)/);
    if (bare?.[1]) {
      const n = Number(bare[1]);
      if (inDocketRange(n)) return { docketId: n };
    }
  }
  return { kind: "no-docket" };
}
