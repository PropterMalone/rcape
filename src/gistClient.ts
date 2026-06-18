// pattern: Imperative Shell
// Thin wrapper over the GitHub REST API to update a single gist file. Used to
// keep the public "shelf" directory gist (owned by PropterMalone) current. We
// hit the API directly with fetch rather than shelling out to `gh` — the bot
// runs under systemd where `gh`'s active-account state is fragile, and a raw
// PATCH with an explicit token avoids that entirely.

const GITHUB_API = "https://api.github.com";

export interface GistUpdateResult {
  ok: boolean;
  // Set on failure for the caller's log line; never thrown so a gist hiccup can't
  // abort a provision (directory regeneration is strictly best-effort).
  error?: string;
}

// PATCH /gists/{id}, replacing one file's content. The token must be a gist-scoped
// PAT for the gist's owner (PropterMalone). Returns rather than throws.
export async function updateGist(
  token: string,
  gistId: string,
  filename: string,
  content: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GistUpdateResult> {
  try {
    const res = await fetchImpl(`${GITHUB_API}/gists/${gistId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        // GitHub rejects requests without a User-Agent.
        "User-Agent": "rcape-directory",
      },
      body: JSON.stringify({ files: { [filename]: { content } } }),
    });
    if (!res.ok) {
      return { ok: false, error: `gist PATCH ${res.status}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
