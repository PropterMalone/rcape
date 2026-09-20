// pattern: Functional Core
// The URL a local atproto client TALKS TO — which is not the same thing as the
// public hostname the PDS issues identities under. The two were conflated until
// 2026-09-20: every AtpAgent on Malone dialled `https://${PDS_HOSTNAME}`, so a
// process sitting beside the PDS container reached it by leaving the box through
// the public tunnel and coming back. That turned a ~1ms loopback hop into a
// 0.6-4.6s round trip, and failed outright often enough to stall the bot's poll
// loop for a whole morning (159 failed cycles before 12:02 ET on 09-20).
//
// PDS_HOSTNAME stays the identity host — handles, `_atproto` DNS, the DIDs
// already written into live repos all depend on it and must NOT change.
// PDS_SERVICE_URL, when set, is the transport and only the transport.

const HTTP_SCHEME = /^https?:\/\//i;

export function resolvePdsServiceUrl(opts: {
  // Raw operator input (`process.env.PDS_SERVICE_URL`). Absent or blank ⇒ no override.
  serviceUrl?: string;
  // Public PDS hostname, no scheme — the pre-override transport, still the default.
  host: string;
}): string {
  const raw = opts.serviceUrl?.trim();
  // `PDS_SERVICE_URL=` with no value is the ordinary .env shape for "not
  // configured" (PDS_ADMIN_PASSWORD already ships that way), so blank must mean
  // unset rather than an empty service URL.
  if (!raw) return `https://${opts.host}`;

  // A malformed override THROWS rather than falling back to `https://${host}`:
  // that fallback is the hairpin this setting exists to avoid, so taking it
  // silently would restore the outage on a box that looks correctly configured.
  // An operator typo surfaces at startup, loudly, which is where it belongs.
  if (!HTTP_SCHEME.test(raw)) {
    throw new Error(
      `PDS_SERVICE_URL must start with http:// or https:// (got "${raw}")`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`PDS_SERVICE_URL is not a valid URL (got "${raw}")`);
  }
  if (!parsed.hostname) {
    throw new Error(`PDS_SERVICE_URL has no host (got "${raw}")`);
  }
  // A path prefix CANNOT be honoured, so it is refused rather than accepted and
  // quietly dropped. @atproto/xrpc resolves each call as `new URL("/xrpc/<nsid>",
  // serviceUri)` (xrpc/dist/client.js:53, util.js:34) — an absolute path, which
  // discards any prefix on the base. Accepting `…:2583/pds` would send traffic to
  // `…:2583/xrpc/…` while the operator believed otherwise; this code previously
  // preserved the prefix and a test asserted that as a guarantee it never had.
  const path = parsed.pathname.replace(/\/+$/, "");
  if (path !== "") {
    throw new Error(
      `PDS_SERVICE_URL must not carry a path — atproto ignores it and calls /xrpc/* at the origin (got "${raw}")`,
    );
  }
  // Plaintext is for reaching a PDS on this machine or this network. Allowing it
  // to an arbitrary host would ship session tokens in the clear, and the setting
  // exists precisely so that case is a loopback hop.
  if (parsed.protocol === "http:" && !isLocalHost(parsed.hostname)) {
    throw new Error(
      `PDS_SERVICE_URL may only use http:// for a loopback or private-network host; use https:// for ${parsed.hostname}`,
    );
  }
  return raw.replace(/\/+$/, "");
}

// Loopback or RFC1918 — the hosts where plaintext never leaves trusted wire.
function isLocalHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::1" || h.startsWith("127.")) return true;
  if (h.startsWith("10.") || h.startsWith("192.168.")) return true;
  const m = h.match(/^172\.(\d{1,2})\./);
  return m ? Number(m[1]) >= 16 && Number(m[1]) <= 31 : false;
}
