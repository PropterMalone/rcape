// pattern: Imperative Shell
// Cloudflare DNS for handle resolution. PDS-issued handles under .rcape.org only
// resolve on the network once a `_atproto.<handle>` TXT record points at the DID
// (there is no wildcard; one TXT per handle). Provisioning calls this right after
// account creation.

const CF = "https://api.cloudflare.com/client/v4";

export interface DnsOptions {
  zoneId: string;
  token: string;
  fetchImpl?: typeof fetch;
}

interface CfEnvelope<T> {
  success: boolean;
  result?: T;
  errors?: unknown;
}

async function cf<T>(
  fetchImpl: typeof fetch,
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<T> {
  const r = await fetchImpl(`${CF}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await r.json()) as CfEnvelope<T>;
  if (!r.ok || !json.success) {
    // Log only the errors array, never the full response body — an unexpected
    // envelope can echo request context we don't want in logs.
    throw new Error(
      `Cloudflare ${method} ${path} failed (${r.status}): ${JSON.stringify(json.errors ?? "no error detail")}`,
    );
  }
  return json.result as T;
}

// Upsert a single `did=<did>` TXT record at the exact name `name`. Shared by the
// handle-resolution records (_atproto.<handle>) and the lexicon-authority record
// (_lexicon.<authority>) — both are the same `did=` TXT shape, differing only in
// the record name.
async function upsertTxt(
  name: string,
  did: string,
  opts: DnsOptions,
): Promise<{ created: boolean }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const record = { type: "TXT", name, content: `did=${did}`, ttl: 60 };

  const existing = await cf<{ id: string }[]>(
    fetchImpl,
    "GET",
    // name.exact (dot notation) is the documented Cloudflare exact-match filter.
    // The previously-used bracket form `name[exact]` is not the documented
    // parameter; its behavior is implementation-defined and not guaranteed to
    // filter at all, so a non-exact match could return an unrelated TXT record
    // that we'd then overwrite. name.exact matches only the exact name.
    `/zones/${opts.zoneId}/dns_records?type=TXT&name.exact=${encodeURIComponent(name)}`,
    opts.token,
  );

  const current = existing[0];
  if (current) {
    await cf(
      fetchImpl,
      "PUT",
      `/zones/${opts.zoneId}/dns_records/${current.id}`,
      opts.token,
      record,
    );
    return { created: false };
  }
  await cf(
    fetchImpl,
    "POST",
    `/zones/${opts.zoneId}/dns_records`,
    opts.token,
    record,
  );
  return { created: true };
}

// Handle resolution: `_atproto.<handle>` TXT → the account DID.
export function upsertAtprotoTxt(
  handle: string,
  did: string,
  opts: DnsOptions,
): Promise<{ created: boolean }> {
  return upsertTxt(`_atproto.${handle}`, did, opts);
}

// Lexicon authority: `_lexicon.<authority-domain>` TXT → the DID whose repo holds
// the com.atproto.lexicon.schema records for that namespace. For `org.rcape.*` the
// authority domain is `rcape.org` (the NSID authority reversed). Resolvers read
// this to find + verify the published lexicons network-wide.
export function upsertLexiconTxt(
  authorityDomain: string,
  did: string,
  opts: DnsOptions,
): Promise<{ created: boolean }> {
  return upsertTxt(`_lexicon.${authorityDomain}`, did, opts);
}
