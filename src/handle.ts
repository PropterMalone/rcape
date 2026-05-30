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
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function cap(slug: string, max: number): string {
  return slug.slice(0, max).replace(/-+$/, "");
}

// "Abrego Garcia v. Noem" -> "Abrego Garcia"; falls back to the whole name.
function plaintiff(caseName: string): string {
  return caseName.split(CASE_SEPARATOR)[0] ?? caseName;
}

export function deriveHandle(
  caseName: string,
  docketNumber: string,
  domain: string,
  taken: ReadonlySet<string> = new Set(),
): string {
  let base = cap(slugify(plaintiff(caseName)), MAX_SLUG);
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
