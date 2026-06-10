// pattern: Functional Core
// Derives a short, DNS-safe, collision-free handle slug for a case account.
// The PDS rejects long handles (the "Handle too long" failure that forced
// abrego-garcia-v-noem… down to abrego-garcia), so slugs are capped well under
// the limit and prefer the plaintiff name for readability.

const MAX_SLUG = 30;
const CASE_SEPARATOR = /\s+vs?\.?\s+/i;

export function slugify(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function cap(slug: string, max: number): string {
  return slug.slice(0, max).replace(/-+$/, "");
}

// A government prosecutor is the plaintiff in every criminal case, so naming the
// handle after the plaintiff collides them all onto one slug ("united-states").
// Anchored exact-match so a civil party that merely contains these words (e.g.
// "United States Steel Corp") is NOT treated as the government.
const GOV_PLAINTIFF =
  /^(the )?(united states( of america)?|u\.?\s?s\.?\s?a?\.?|people|state|commonwealth)$/i;

// The party to name the handle after: the defendant when the plaintiff is a
// government prosecutor (criminal cases), otherwise the plaintiff. Falls back to
// the whole name when there's no "v." separator (e.g. "In re ...").
function namedParty(caseName: string): string {
  const parts = caseName.split(CASE_SEPARATOR);
  const first = (parts[0] ?? caseName).trim();
  if (parts.length > 1 && GOV_PLAINTIFF.test(first)) {
    return parts.slice(1).join(" ").trim() || first;
  }
  return first || caseName;
}

export function deriveHandle(
  caseName: string,
  docketNumber: string,
  domain: string,
  taken: ReadonlySet<string> = new Set(),
): string {
  let base = cap(slugify(namedParty(caseName)), MAX_SLUG);
  if (!base) base = cap(slugify(`case-${docketNumber}`), MAX_SLUG);

  let candidate = base;
  let n = 1;
  while (taken.has(`${candidate}.${domain}`)) {
    n += 1;
    const suffix = `-${n}`;
    candidate = `${cap(base, MAX_SLUG - suffix.length)}${suffix}`;
  }
  return `${candidate}.${domain}`;
}
