// pattern: Functional Core
// Builds app.bsky.richtext.facet#mention facets for the @handles in a reply.
// Per the AT Protocol richtext spec, a mention facet "Produces a notification
// for the mentioned user" — without one the @handle renders as inert text and
// the provisioned case account (and @proptermalone) are never notified or
// linked. Facet byte ranges are indexed in UTF-8 BYTES, not JS chars, so a
// multibyte char before the handle (e.g. an em dash or ellipsis) must shift the
// offset — char offsets would point the facet a few bytes too early. We compute
// offsets with Buffer.byteLength on the text slice up to each match.

export interface MentionFacet {
  index: { byteStart: number; byteEnd: number };
  features: Array<{ $type: "app.bsky.richtext.facet#mention"; did: string }>;
}

// Whether `@<handle>` ending at index `end` is a WHOLE handle, i.e. the text
// doesn't continue it into a longer handle. Mirrors Bluesky's richtext rule: a
// trailing "." or "-" is sentence punctuation (ends the handle) UNLESS an
// alphanumeric follows it (then it's a domain separator, so the match is a
// prefix of a longer handle and must be rejected). A bare alphanumeric right
// after also means a longer handle.
function isWholeHandleBoundary(text: string, end: number): boolean {
  const next = text[end];
  if (next === undefined) return true; // end of string
  if (/[A-Za-z0-9]/.test(next)) return false; // handle continues
  if (next === "." || next === "-") {
    // "." / "-" continues the handle only if an alphanumeric follows it.
    return !/[A-Za-z0-9]/.test(text[end + 1] ?? "");
  }
  return true; // space, em dash, punctuation, etc. — handle ends here
}

// Find every occurrence of `@<handle>` in `text` (handle drawn from the keys of
// `dids`) where the match is a whole handle — so a known short handle ("case")
// never matches inside a longer one ("@case.rcape.org"), while a trailing
// sentence period ("@proptermalone.") is treated as punctuation, not domain.
// Offsets are UTF-8 byte indices.
export function mentionFacets(
  text: string,
  dids: Record<string, string>,
): MentionFacet[] {
  const facets: MentionFacet[] = [];
  for (const [handle, did] of Object.entries(dids)) {
    const needle = `@${handle}`;
    let from = 0;
    while (true) {
      const at = text.indexOf(needle, from);
      if (at === -1) break;
      if (isWholeHandleBoundary(text, at + needle.length)) {
        const byteStart = Buffer.byteLength(text.slice(0, at), "utf8");
        const byteEnd = byteStart + Buffer.byteLength(needle, "utf8");
        facets.push({
          index: { byteStart, byteEnd },
          features: [{ $type: "app.bsky.richtext.facet#mention", did }],
        });
      }
      from = at + needle.length;
    }
  }
  // Stable order: by byteStart, so concurrent multi-handle replies are deterministic.
  return facets.sort((a, b) => a.index.byteStart - b.index.byteStart);
}

// A richtext record's outbound link URLs, drawn from its `#link` facets. Bluesky
// truncates long URLs in the visible post text (".../docket/71795...") while the
// facet preserves the full URL, so docket parsing must read these — not the text.
// Shared so incoming-notification parsing (toMention) and thread-post scanning
// extract links identically.
export interface RichtextRecord {
  facets?: { features?: { $type?: string; uri?: string }[] }[];
}
export function extractLinkFacets(record: RichtextRecord): string[] {
  return (record.facets ?? [])
    .flatMap((f) => f.features ?? [])
    .filter(
      (ft) =>
        ft.$type === "app.bsky.richtext.facet#link" &&
        typeof ft.uri === "string",
    )
    .map((ft) => ft.uri as string);
}
