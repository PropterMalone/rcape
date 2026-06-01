import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type CaseEntry,
  DAILY_CAP,
  type Ledger,
  chargeQuota,
  emptyLedger,
  findCase,
  loadLedger,
  quotaRemaining,
  recordCase,
  saveLedger,
  selectToken,
  takenHandles,
  tokenId,
} from "./ledger.js";

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
