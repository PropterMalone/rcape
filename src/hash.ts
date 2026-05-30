// pattern: Imperative Shell
// Fetches document bytes and computes content CIDs (hash+link tamper-evidence).
// Failures are skipped: a missing CID just means tamper-evidence is unavailable
// for that document, not a build failure.

import { cidForBytes } from "./cid.js";

export async function hashDocuments(
  urls: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const url of urls) {
    if (out.has(url)) continue;
    try {
      const res = await fetchImpl(url);
      if (!res.ok) continue;
      const bytes = new Uint8Array(await res.arrayBuffer());
      out.set(url, await cidForBytes(bytes));
    } catch {
      // unreachable document; leave CID absent
    }
  }
  return out;
}
