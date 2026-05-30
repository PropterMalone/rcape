// pattern: Functional Core
// Pulls a CourtListener docket id out of a CLI argument or free @-mention text.
// v1 accepts a CL docket URL or a bare CL docket id only — case-name search is
// deliberately out of scope (it needs CL's search API + disambiguation).

// CLI arg: a bare number, or a URL containing /docket/<id>/.
export function parseDocketId(arg: string | undefined): number | null {
  if (!arg) return null;
  if (/^\d+$/.test(arg)) return Number(arg);
  const m = arg.match(/docket\/(\d+)/);
  return m ? Number(m[1]) : null;
}

// Free mention text (e.g. "@ape.rcape.org please add
// courtlistener.com/docket/69777799/..."). Prefer a docket URL; fall back to a
// standalone 6+ digit run (CL internal docket ids are 7-9 digits — this avoids
// matching years and case numbers like 8:25-cv-00951).
export function parseMention(
  text: string,
): { docketId: number } | { kind: "no-docket" } {
  const url = text.match(/\/docket\/(\d+)/i);
  if (url?.[1]) return { docketId: Number(url[1]) };
  const bare = text.match(/(?<!\d)(\d{6,})(?!\d)/);
  if (bare?.[1]) return { docketId: Number(bare[1]) };
  return { kind: "no-docket" };
}
