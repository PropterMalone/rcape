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

export async function upsertAtprotoTxt(
  handle: string,
  did: string,
  opts: DnsOptions,
): Promise<{ created: boolean }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const name = `_atproto.${handle}`;
  const record = { type: "TXT", name, content: `did=${did}`, ttl: 60 };

  const existing = await cf<{ id: string }[]>(
    fetchImpl,
    "GET",
    // name[exact] (not the default substring match): a plain `name=` filter
    // would also return records whose name merely CONTAINS this one (e.g. a
    // sibling subdomain), so we'd risk updating/deleting the wrong record. We
    // want the single record for exactly _atproto.<handle>.
    `/zones/${opts.zoneId}/dns_records?type=TXT&name[exact]=${encodeURIComponent(name)}`,
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
