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

export interface LinkFacet {
  index: { byteStart: number; byteEnd: number };
  features: Array<{ $type: "app.bsky.richtext.facet#link"; uri: string }>;
}

// Build #link facets for every http(s) URL in `text` so plain-text URLs (e.g. in
// the pinned directory post) render as tappable links. Without a facet a URL is
// inert text. Offsets are UTF-8 BYTE indices, same as mentionFacets — a multibyte
// char before the URL must shift the offset. A trailing ")"/"."/"," is excluded
// from the match so sentence punctuation isn't swallowed into the link.
export function linkFacets(text: string): LinkFacet[] {
  const facets: LinkFacet[] = [];
  const re = /https?:\/\/[^\s)]+[^\s).,]/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec loop
  while ((m = re.exec(text)) !== null) {
    const uri = m[0];
    const byteStart = Buffer.byteLength(text.slice(0, m.index), "utf8");
    const byteEnd = byteStart + Buffer.byteLength(uri, "utf8");
    facets.push({
      index: { byteStart, byteEnd },
      features: [{ $type: "app.bsky.richtext.facet#link", uri }],
    });
  }
  return facets;
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
  // A post's single embed, in RECORD form (`app.bsky.embed.external` for a link
  // card, `app.bsky.embed.record#view` etc. for quotes). News/link cards put the
  // article URL + title + description HERE, not in a #link facet — so a shared
  // article (a WSJ docket story, a court press release) is invisible to
  // facet-only extraction unless we read the embed too.
  embed?: {
    $type?: string;
    external?: { uri?: string; title?: string; description?: string };
  };
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

export interface ExternalEmbed {
  uri?: string;
  title?: string;
  description?: string;
}

// The external link card on a post (its URL + the card's title/description), or
// undefined when the post has no `app.bsky.embed.external`. The card title is
// often the only place a vague poster comment ("can you pull this one?") gains
// any case signal ("Anthropic Sued Over Limits on Its $200-a-Month AI Plans").
export function extractExternalEmbed(
  record: RichtextRecord,
): ExternalEmbed | undefined {
  const e = record.embed;
  if (e?.$type !== "app.bsky.embed.external" || !e.external) return undefined;
  const { uri, title, description } = e.external;
  return { uri, title, description };
}

// All outbound URLs on a post: its #link facet URLs plus an external link-card
// URL. The card URL is appended (deduped) so a docket link shared as a card — or
// an article link feedable to url_context — is seen alongside facet links.
export function extractPostLinks(record: RichtextRecord): string[] {
  const links = extractLinkFacets(record);
  const cardUri = extractExternalEmbed(record)?.uri;
  if (cardUri && !links.includes(cardUri)) links.push(cardUri);
  return links;
}

// A post's text augmented with its link-card title + description, joined for the
// case-inference prompt. The card copy carries the headline/summary, which a
// terse human comment omits — folding it into the entry text gives the model the
// real signal without a separate field.
export function postTextWithCard(
  record: RichtextRecord & { text?: string },
): string {
  const card = extractExternalEmbed(record);
  return [record.text ?? "", card?.title, card?.description]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join(" — ");
}
