import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type CaseEntry,
  DAILY_CAP,
  HARVEST_FLOOR_DEFAULT,
  type Ledger,
  MIN_QUOTA_FOR_CASE,
  RESERVED_CALLS_PER_CASE,
  WATCHLIST_FLOOR_DEFAULT,
  chargeAndRecord,
  chargeQuota,
  emptyLedger,
  findCase,
  isThrottled,
  loadLedger,
  markTokenThrottled,
  quotaRemaining,
  recordCalls,
  recordCase,
  rollingStartableAt,
  saveLedger,
  selectToken,
  takenHandles,
  tokenId,
} from "./ledger.js";

const HR = 3_600_000;

const DAY = "2026-05-30";

describe("findCase / recordCase", () => {
  it("returns undefined for an unknown docket", () => {
    expect(findCase(emptyLedger(), 123)).toBeUndefined();
  });

  it("round-trips a recorded case keyed by CL docket id", () => {
    const l = recordCase(emptyLedger(), 69777799, {
      did: "did:plc:abc",
      handle: "abrego-garcia.rcape.org",
      password: "pw",
      createdAt: DAY,
    });
    const found = findCase(l, 69777799);
    expect(found?.did).toBe("did:plc:abc");
    expect(found?.handle).toBe("abrego-garcia.rcape.org");
  });

  it("does not mutate the input ledger", () => {
    const l0 = emptyLedger();
    recordCase(l0, 1, { did: "d", handle: "h", password: "p", createdAt: DAY });
    expect(findCase(l0, 1)).toBeUndefined();
  });

  it("archives the prior account when a different DID is recorded (--force)", () => {
    let l = recordCase(emptyLedger(), 1, {
      did: "did:plc:first",
      handle: "smith.rcape.org",
      password: "pw-first",
      createdAt: DAY,
    });
    l = recordCase(l, 1, {
      did: "did:plc:second",
      handle: "smith-2.rcape.org",
      password: "pw-second",
      createdAt: DAY,
    });
    const found = findCase(l, 1);
    expect(found?.did).toBe("did:plc:second");
    // the displaced account's credentials survive — never silently dropped
    expect(found?.superseded?.[0]?.did).toBe("did:plc:first");
    expect(found?.superseded?.[0]?.password).toBe("pw-first");
  });

  it("updates in place on a same-DID write without archiving", () => {
    let l = recordCase(emptyLedger(), 1, {
      did: "did:plc:x",
      handle: "h",
      password: "pw",
      createdAt: DAY,
    });
    l = recordCase(l, 1, {
      did: "did:plc:x",
      handle: "h",
      password: "pw",
      createdAt: DAY,
      highWater: "099",
    });
    const found = findCase(l, 1);
    expect(found?.highWater).toBe("099");
    expect(found?.superseded).toBeUndefined();
  });

  it("fills the DID on a credentials-first pending entry without archiving it", () => {
    // Crash-window hardening: a pending entry is persisted (handle+password, no
    // DID) before the account is minted, then the DID is filled in afterward.
    // That fill is a same-case completion, NOT a --force re-provision — it must
    // merge, not archive the pending entry into superseded.
    let l = recordCase(emptyLedger(), 1, {
      handle: "doe.rcape.org",
      password: "pw",
      createdAt: DAY,
    } as unknown as CaseEntry);
    l = recordCase(l, 1, {
      did: "did:plc:minted",
      handle: "doe.rcape.org",
      password: "pw",
      createdAt: DAY,
    });
    const found = findCase(l, 1);
    expect(found?.did).toBe("did:plc:minted");
    expect(found?.superseded).toBeUndefined();
  });

  it("marks completed only on the terminal write and keeps it across later merges", () => {
    // Early-persist (no completed) then terminal write (completed) then a future
    // partial update: completed must stick once set.
    let l = recordCase(emptyLedger(), 1, {
      did: "did:plc:x",
      handle: "h.rcape.org",
      password: "pw",
      createdAt: DAY,
    });
    expect(findCase(l, 1)?.completed).toBeUndefined();
    l = recordCase(l, 1, {
      did: "did:plc:x",
      handle: "h.rcape.org",
      password: "pw",
      createdAt: DAY,
      completed: true,
      highWater: "010",
    });
    expect(findCase(l, 1)?.completed).toBe(true);
    // A later partial update that omits `completed` must not clear it.
    l = recordCase(l, 1, { highWater: "020" } as unknown as CaseEntry);
    expect(findCase(l, 1)?.completed).toBe(true);
    expect(findCase(l, 1)?.highWater).toBe("020");
  });

  it("merges a partial same-DID update so omitted fields are not clobbered", () => {
    let l = recordCase(emptyLedger(), 1, {
      did: "did:plc:x",
      handle: "h.rcape.org",
      password: "irreplaceable-pw",
      createdAt: DAY,
    });
    // A future partial-update caller (watched-case monitor) writes only the new
    // highWater. The merge must preserve the password + createdAt + handle.
    l = recordCase(l, 1, { highWater: "099" } as unknown as CaseEntry);
    const found = findCase(l, 1);
    expect(found?.highWater).toBe("099");
    expect(found?.password).toBe("irreplaceable-pw");
    expect(found?.createdAt).toBe(DAY);
    expect(found?.handle).toBe("h.rcape.org");
  });
});

describe("takenHandles", () => {
  it("is empty for a fresh ledger", () => {
    expect(takenHandles(emptyLedger()).size).toBe(0);
  });

  it("includes live case handles and superseded (force-displaced) handles", () => {
    let l = recordCase(emptyLedger(), 1, {
      did: "did:plc:first",
      handle: "smith.rcape.org",
      password: "pw1",
      createdAt: DAY,
    });
    // --force re-provision: smith.rcape.org is displaced into superseded but is
    // still a live account on the PDS, so it stays spoken-for.
    l = recordCase(l, 1, {
      did: "did:plc:second",
      handle: "smith-2.rcape.org",
      password: "pw2",
      createdAt: DAY,
    });
    const taken = takenHandles(l);
    expect(taken.has("smith-2.rcape.org")).toBe(true);
    expect(taken.has("smith.rcape.org")).toBe(true);
  });
});

describe("quota (5/min self-throttle aside, 125/day cap per token)", () => {
  const TOK = "token-a";

  it("reports the full daily budget for a fresh day", () => {
    expect(quotaRemaining(emptyLedger(), DAY, TOK)).toBe(125);
  });

  it("decrements as calls are charged within the same day", () => {
    let l: Ledger = emptyLedger();
    l = chargeQuota(l, 5, DAY, TOK);
    expect(quotaRemaining(l, DAY, TOK)).toBe(120);
    l = chargeQuota(l, 20, DAY, TOK);
    expect(quotaRemaining(l, DAY, TOK)).toBe(100);
  });

  it("rolls over to a full budget on a new day", () => {
    let l: Ledger = emptyLedger();
    l = chargeQuota(l, 100, DAY, TOK);
    expect(quotaRemaining(l, DAY, TOK)).toBe(25);
    expect(quotaRemaining(l, "2026-05-31", TOK)).toBe(125);
    l = chargeQuota(l, 3, "2026-05-31", TOK);
    expect(quotaRemaining(l, "2026-05-31", TOK)).toBe(122);
  });

  it("clamps remaining at zero, never negative", () => {
    let l: Ledger = emptyLedger();
    l = chargeQuota(l, 200, DAY, TOK);
    expect(quotaRemaining(l, DAY, TOK)).toBe(0);
  });

  it("accumulates multiple charges on the same new day after a rollover", () => {
    let l: Ledger = emptyLedger();
    l = chargeQuota(l, 50, DAY, TOK);
    expect(quotaRemaining(l, DAY, TOK)).toBe(75);
    // New day: the prior day's count is dropped, then same-day charges add up.
    l = chargeQuota(l, 10, "2026-05-31", TOK);
    l = chargeQuota(l, 7, "2026-05-31", TOK);
    expect(quotaRemaining(l, "2026-05-31", TOK)).toBe(DAILY_CAP - 17);
    // The prior day no longer governs the counter.
    expect(quotaRemaining(l, DAY, TOK)).toBe(DAILY_CAP);
  });
});

describe("token pool (per-token quota + selection)", () => {
  it("tracks each token's budget independently", () => {
    let l: Ledger = emptyLedger();
    l = chargeQuota(l, 100, DAY, "token-a");
    // token-a is nearly spent; token-b is untouched.
    expect(quotaRemaining(l, DAY, "token-a")).toBe(25);
    expect(quotaRemaining(l, DAY, "token-b")).toBe(125);
  });

  it("resets every token's counter on a new day", () => {
    let l: Ledger = emptyLedger();
    l = chargeQuota(l, 120, DAY, "token-a");
    l = chargeQuota(l, 120, DAY, "token-b");
    expect(quotaRemaining(l, "2026-05-31", "token-a")).toBe(125);
    expect(quotaRemaining(l, "2026-05-31", "token-b")).toBe(125);
  });

  it("keys counters by a non-secret fingerprint, never the raw token", () => {
    const id = tokenId("super-secret-token");
    expect(id).not.toContain("super-secret");
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    let l: Ledger = emptyLedger();
    l = chargeQuota(l, 10, DAY, "super-secret-token");
    // The raw token does not appear as a key.
    expect(Object.keys(l.quota.counts)).toEqual([id]);
  });

  it("selectToken picks the first token with enough headroom for a case", () => {
    let l: Ledger = emptyLedger();
    // token-a has only 10 left (< 17 needed); token-b is fresh.
    l = chargeQuota(l, 115, DAY, "token-a");
    expect(selectToken(l, ["token-a", "token-b"], DAY, 17)).toBe("token-b");
  });

  it("selectToken returns undefined when every token is exhausted", () => {
    let l: Ledger = emptyLedger();
    l = chargeQuota(l, 120, DAY, "token-a");
    l = chargeQuota(l, 120, DAY, "token-b");
    expect(selectToken(l, ["token-a", "token-b"], DAY, 17)).toBeUndefined();
  });

  it("selectToken skips a throttled token (with nowMs) but uses it after the cooldown", () => {
    const now = 1_000_000;
    let l: Ledger = emptyLedger(); // both tokens fully funded
    l = markTokenThrottled(l, "token-a", new Date(now + 60_000).toISOString());
    // token-a funded but cooling down → token-b is chosen.
    expect(selectToken(l, ["token-a", "token-b"], DAY, 17, now)).toBe(
      "token-b",
    );
    // After the cooldown elapses, token-a is eligible again (first in list).
    expect(selectToken(l, ["token-a", "token-b"], DAY, 17, now + 61_000)).toBe(
      "token-a",
    );
    // Single throttled token + nowMs → none qualifies.
    expect(selectToken(l, ["token-a"], DAY, 17, now)).toBeUndefined();
    // Omitting nowMs ignores throttling entirely (legacy callers).
    expect(selectToken(l, ["token-a"], DAY, 17)).toBe("token-a");
  });

  it("isThrottled reflects the cooldown window", () => {
    const now = 1_000_000;
    const l = markTokenThrottled(
      emptyLedger(),
      "token-a",
      new Date(now + 30_000).toISOString(),
    );
    expect(isThrottled(l, "token-a", now)).toBe(true);
    expect(isThrottled(l, "token-a", now + 31_000)).toBe(false);
    expect(isThrottled(l, "token-b", now)).toBe(false); // never throttled
  });

  it("drops a stale (older-day) charge instead of wiping the newer day's counters", () => {
    // Reconcile straddling UTC midnight: a concurrent writer already rolled the
    // day to D2 and reserved against token-b. A late reconcile for D1 must not
    // reset D2 or revert the day.
    const l: Ledger = {
      cases: {},
      quota: { day: "2026-06-02", counts: { [tokenId("token-b")]: 50 } },
    };
    const after = chargeQuota(l, -16, "2026-06-01", "token-a");
    expect(after.quota.day).toBe("2026-06-02");
    expect(after.quota.counts[tokenId("token-b")]).toBe(50);
    expect(quotaRemaining(after, "2026-06-02", "token-a")).toBe(125);
  });

  it("clamps a same-day counter at zero rather than going negative", () => {
    let l: Ledger = emptyLedger();
    l = chargeQuota(l, 5, DAY, "token-a");
    // An over-large refund (reconcile delta) must not drive the counter negative,
    // which would make quotaRemaining report MORE than the daily cap.
    l = chargeQuota(l, -20, DAY, "token-a");
    expect(l.quota.counts[tokenId("token-a")]).toBe(0);
    expect(quotaRemaining(l, DAY, "token-a")).toBe(125);
  });

  it("migrates a legacy {day,count} ledger into a conservative shared floor", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rcape-ledger-"));
    try {
      const path = join(dir, "ledger.json");
      // Pre-pool on-disk shape.
      await writeFile(
        path,
        JSON.stringify({ cases: {}, quota: { day: DAY, count: 17 } }),
      );
      const l = await loadLedger(path);
      // The legacy spend is charged against EVERY token for that day (floor),
      // never under-counted — so the CL cap can't be exceeded after upgrade.
      expect(quotaRemaining(l, DAY, "token-a")).toBe(125 - 17);
      expect(quotaRemaining(l, DAY, "token-b")).toBe(125 - 17);
      // Next day clears it.
      expect(quotaRemaining(l, "2026-05-31", "token-a")).toBe(125);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("rolling-window call log (predictive 5/min·50/hr·125/24h gate)", () => {
  const TOK = "token-a";
  // A fixed wall-clock anchor; all timestamps are offsets from it (no Date.now).
  const NOW = 1_750_000_000_000;

  it("records calls and prunes entries older than the 24h window", () => {
    let l: Ledger = recordCalls(emptyLedger(), TOK, NOW, 3);
    expect(l.calls?.[tokenId(TOK)]?.length).toBe(3);
    // A later charge past 24h prunes the now-stale entries as it appends.
    l = recordCalls(l, TOK, NOW + 25 * HR, 1);
    expect(l.calls?.[tokenId(TOK)]?.length).toBe(1);
  });

  it("is startable immediately when the log is empty", () => {
    expect(rollingStartableAt(emptyLedger(), TOK, 12, NOW)).toBeLessThanOrEqual(
      NOW,
    );
  });

  it("blocks on the 5/min window and reopens when the oldest minute-call ages out", () => {
    // 5 calls this minute → the 6th would 429 ("5/min", verified live 2026-06-17).
    const l = recordCalls(emptyLedger(), TOK, NOW, 5);
    expect(rollingStartableAt(l, TOK, 12, NOW)).toBe(NOW + 60_000);
    // Once 60s pass, the minute window has room again.
    expect(rollingStartableAt(l, TOK, 12, NOW + 60_001)).toBeLessThanOrEqual(
      NOW + 60_001,
    );
  });

  it("does not apply the case-size `need` to the small 5/min window", () => {
    // 3 calls this minute, need=12: the minute window (cap 5) must NOT demand 12
    // free or it would be permanently unsatisfiable. need governs the 24h budget.
    const l = recordCalls(emptyLedger(), TOK, NOW, 3);
    expect(rollingStartableAt(l, TOK, 12, NOW)).toBeLessThanOrEqual(NOW);
  });

  it("blocks on the 50/hr window and reopens ~1h out (the binding window past the minute)", () => {
    // 50 calls in the hour → the 51st would 429 on the 50/hr scope (a 2026-06-16
    // freeze cause). need=1 (the small windows ignore case-size need). The 50/hr
    // reopen (NOW + 1h) dominates the 5/min reopen (NOW + 60s), so the gate is the
    // hour window. Deleting {windowMs:3_600_000,cap:50} from CL_RATE_WINDOWS would
    // make this NOW + 60s and fail — closing the gap that left all 393 green.
    const l = recordCalls(emptyLedger(), TOK, NOW, 50);
    expect(rollingStartableAt(l, TOK, 1, NOW)).toBe(NOW + HR);
    expect(rollingStartableAt(l, TOK, 1, NOW)).toBeGreaterThan(NOW);
    // Once the hour passes, the window has room again.
    expect(rollingStartableAt(l, TOK, 1, NOW + HR + 1)).toBeLessThanOrEqual(
      NOW + HR + 1,
    );
  });

  it("blocks on the 125/24h rolling window and reopens exactly when calls age out", () => {
    // 120 calls made 23h ago: minute & hour windows are clear now, but the 24h
    // window is at 120/125 — starting a case that needs 12 would breach it. They
    // age out of the rolling window at t0 + 24h (= NOW + 1h).
    const t0 = NOW - 23 * HR;
    const l = recordCalls(emptyLedger(), TOK, t0, 120);
    expect(rollingStartableAt(l, TOK, 12, NOW)).toBe(NOW + HR);
  });

  it("chargeAndRecord charges the calendar delta and records ALL calls atomically", () => {
    // A monitor/provision reconcile: 8 calls actually spent, 5 reserved upfront.
    // Calendar quota gets the delta (8 - 5 = 3); the rolling log gets all 8.
    const reserved = chargeQuota(emptyLedger(), 5, DAY, TOK); // upfront reservation
    const after = chargeAndRecord(reserved, 8, DAY, TOK, NOW, 5);
    expect(after.quota.counts[tokenId(TOK)]).toBe(8); // 5 reserved + 3 delta
    expect(after.calls?.[tokenId(TOK)]?.length).toBe(8); // all 8 in the rolling log
  });

  it("chargeAndRecord with no reservation charges and records the same N (the search sites)", () => {
    const after = chargeAndRecord(emptyLedger(), 1, DAY, TOK, NOW);
    expect(after.quota.counts[tokenId(TOK)]).toBe(1);
    expect(after.calls?.[tokenId(TOK)]?.length).toBe(1);
  });

  it("selectToken honors the rolling gate only when nowMs is supplied (the root-cause fix)", () => {
    // The 2026-06-16 freeze: the calendar counter read fresh after the 8pm reset
    // (new day → 125 free) while CL's rolling 24h window still held us locked.
    const t0 = NOW - 23 * HR;
    const l = recordCalls(emptyLedger(), TOK, t0, 120);
    // Legacy call (no nowMs): only the calendar counter is consulted → selected.
    expect(selectToken(l, [TOK], DAY, 12)).toBe(TOK);
    // With nowMs: the rolling 24h window blocks the start BEFORE we'd 429.
    expect(selectToken(l, [TOK], DAY, 12, NOW)).toBeUndefined();
    // After the old calls age out, the token is startable again.
    expect(selectToken(l, [TOK], DAY, 12, NOW + HR + 1)).toBe(TOK);
  });
});

describe("crash-safe persistence", () => {
  it("recovers a recorded case from .bak when ledger.json is truncated", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rcape-ledger-"));
    try {
      const path = join(dir, "ledger.json");
      const l1 = recordCase(emptyLedger(), 1, {
        did: "did:plc:one",
        handle: "one.rcape.org",
        password: "pw-one",
        createdAt: DAY,
      });
      await saveLedger(path, l1);
      // Second save populates .bak with the first good state.
      const l2 = recordCase(l1, 2, {
        did: "did:plc:two",
        handle: "two.rcape.org",
        password: "pw-two",
        createdAt: DAY,
      });
      await saveLedger(path, l2);
      // Crash mid-write leaves a torn primary file.
      await writeFile(path, '{"cases": {"1": {"did": "did:plc:on');
      const recovered = await loadLedger(path);
      // Falls back to .bak (the single-case state), not a throw or empty reset.
      expect(findCase(recovered, 1)?.password).toBe("pw-one");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("saves via temp+rename so the primary is never left truncated", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rcape-ledger-"));
    try {
      const path = join(dir, "ledger.json");
      await saveLedger(path, emptyLedger());
      // No leftover temp file; primary parses cleanly.
      expect(await readdir(dir)).not.toContain("ledger.json.tmp");
      JSON.parse(await readFile(path, "utf8"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("budget-priority floors", () => {
  it("preserves the fairness ladder by-request/monitor < watchlist < harvest", () => {
    // The monitor rung IS MIN_QUOTA_FOR_CASE (monitor.ts imports it directly), so
    // the by-request <= monitor leg is an identity; assert the remaining strict legs.
    expect(MIN_QUOTA_FOR_CASE).toBeLessThan(WATCHLIST_FLOOR_DEFAULT);
    expect(WATCHLIST_FLOOR_DEFAULT).toBeLessThan(HARVEST_FLOOR_DEFAULT);
  });

  it("keeps the historical floor values (no behavior change on centralizing)", () => {
    expect(RESERVED_CALLS_PER_CASE).toBe(10);
    expect(MIN_QUOTA_FOR_CASE).toBe(12); // by-request AND monitor rung
    expect(WATCHLIST_FLOOR_DEFAULT).toBe(24);
    expect(HARVEST_FLOOR_DEFAULT).toBe(60);
  });

  it("derives MIN_QUOTA_FOR_CASE as RESERVED plus a race buffer", () => {
    expect(MIN_QUOTA_FOR_CASE).toBeGreaterThan(RESERVED_CALLS_PER_CASE);
  });
});
