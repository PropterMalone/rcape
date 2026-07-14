// pattern: Functional Core + Imperative Shell
// @ape.rcape.org follows every shelved case account, so its Bluesky "Following"
// tab is a native, in-app directory of the whole archive — tap @ape → Following →
// any case, without leaving Bluesky. Complements the gist/graph.list directory
// (a followable list) with the follow graph itself.
//
// Quota-free: this is PURELY the bot's own PDS (list its follow records, create
// new ones) — no CourtListener call. Self-healing: the sweep diffs the completed
// shelf against who @ape already follows and only follows the gap, so it backfills
// the existing shelf on first run and needs no per-provision bookkeeping.

import type { BotAgent } from "./botAgent.js";
import {
  type Ledger,
  loadLedger,
  mutateLedger,
  recordFollowsSwept,
} from "./ledger.js";

const FOLLOW = "app.bsky.graph.follow";

// How often to re-list the bot's own follow records absent a shelf change. The
// shelf-change gate (pollOnce passes force=true) makes new cases follow the same
// cycle they're shelved; this interval is only the drift backstop (a failed
// follow, a case provisioned by a path that didn't force a sweep). Overridable
// for tests/ops via RCAPE_FOLLOW_SWEEP_INTERVAL_MS.
const DEFAULT_FOLLOW_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

// Guard a malformed env override. A bare Number() lets a typo silently break the
// gate: "abc" → NaN (nowMs - swept >= NaN is always false → NEVER due, the sweep
// dies), and "" → 0 (always due → re-lists the PDS every 60s poll, a spin). Only
// a finite positive number is honored; anything else falls back to the default.
export function parseInterval(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_FOLLOW_SWEEP_INTERVAL_MS;
}
const FOLLOW_SWEEP_INTERVAL_MS = parseInterval(
  process.env.RCAPE_FOLLOW_SWEEP_INTERVAL_MS,
);

// The minimal deps the sweep needs — a structural subset of BotDeps, so pollOnce
// passes its full deps and tests pass a hand-rolled pair.
export interface FollowSweepDeps {
  agent: Pick<BotAgent, "listRecords" | "createRecord">;
  cfg: { ledgerPath: string };
}

// pattern: Functional Core
// DIDs of completed case accounts not already followed, deduped, input order
// preserved (so the follow order is stable/deterministic for a given ledger).
export function casesToFollow(
  caseDids: readonly string[],
  followedDids: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const did of caseDids) {
    if (!did || followedDids.has(did) || seen.has(did)) continue;
    seen.add(did);
    out.push(did);
  }
  return out;
}

// The subject DID of an app.bsky.graph.follow record value, or undefined when the
// record is malformed (defensive — the bot's repo should only hold well-formed
// follows, but a hand-edited or partial record must not crash the sweep).
export function followSubject(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const s = (value as { subject?: unknown }).subject;
  return typeof s === "string" ? s : undefined;
}

// Completed case account DIDs from the ledger. A case counts only when it has BOTH
// a did and a handle and is completed — a crash zombie (present but no resolvable
// account yet) has no account to follow.
export function completedCaseDids(ledger: Ledger): string[] {
  const dids: string[] = [];
  for (const c of Object.values(ledger.cases)) {
    if (c.completed && c.did && c.handle) dids.push(c.did);
  }
  return dids;
}

// pattern: Imperative Shell
// One follow sweep. Self-gates on cadence unless `force` (a shelf change this
// cycle). Best-effort per follow: one failed write is logged and skipped, never
// aborts the rest — the unfollowed case simply reappears in the next due sweep's
// diff. Returns the count actually followed this run.
export async function followShelvedCasesOnce(
  deps: FollowSweepDeps,
  opts: { force?: boolean } = {},
): Promise<{ followed: number }> {
  const ledger = await loadLedger(deps.cfg.ledgerPath);
  const sweptMs = Date.parse(ledger.follows?.sweptAt ?? "") || 0;
  const due = opts.force || Date.now() - sweptMs >= FOLLOW_SWEEP_INTERVAL_MS;
  if (!due) return { followed: 0 };

  const wanted = completedCaseDids(ledger);
  if (wanted.length === 0) {
    // Nothing to follow, but stamp so the cadence gate still advances.
    await mutateLedger(deps.cfg.ledgerPath, (l) =>
      recordFollowsSwept(l, new Date().toISOString()),
    );
    return { followed: 0 };
  }

  const existing = await deps.agent.listRecords(FOLLOW);
  const followedDids = new Set<string>();
  for (const r of existing) {
    const s = followSubject(r.value);
    if (s) followedDids.add(s);
  }

  const toFollow = casesToFollow(wanted, followedDids);
  let followed = 0;
  for (const subject of toFollow) {
    try {
      await deps.agent.createRecord(FOLLOW, {
        $type: FOLLOW,
        subject,
        createdAt: new Date().toISOString(),
      });
      followed += 1;
    } catch (e) {
      console.error(
        `follow sweep: failed to follow ${subject}:`,
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  await mutateLedger(deps.cfg.ledgerPath, (l) =>
    recordFollowsSwept(l, new Date().toISOString()),
  );
  if (followed > 0) {
    console.log(`follow sweep: @ape now follows ${followed} more case(s)`);
  }
  return { followed };
}
