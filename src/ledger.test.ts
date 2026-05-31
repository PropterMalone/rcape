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

describe("quota (5/min self-throttle aside, 125/day cap)", () => {
  it("reports the full daily budget for a fresh day", () => {
    expect(quotaRemaining(emptyLedger(), DAY)).toBe(125);
  });

  it("decrements as calls are charged within the same day", () => {
    let l: Ledger = emptyLedger();
    l = chargeQuota(l, 5, DAY);
    expect(quotaRemaining(l, DAY)).toBe(120);
    l = chargeQuota(l, 20, DAY);
    expect(quotaRemaining(l, DAY)).toBe(100);
  });

  it("rolls over to a full budget on a new day", () => {
    let l: Ledger = emptyLedger();
    l = chargeQuota(l, 100, DAY);
    expect(quotaRemaining(l, DAY)).toBe(25);
    expect(quotaRemaining(l, "2026-05-31")).toBe(125);
    l = chargeQuota(l, 3, "2026-05-31");
    expect(quotaRemaining(l, "2026-05-31")).toBe(122);
  });

  it("clamps remaining at zero, never negative", () => {
    let l: Ledger = emptyLedger();
    l = chargeQuota(l, 200, DAY);
    expect(quotaRemaining(l, DAY)).toBe(0);
  });

  it("accumulates multiple charges on the same new day after a rollover", () => {
    let l: Ledger = emptyLedger();
    l = chargeQuota(l, 50, DAY);
    expect(quotaRemaining(l, DAY)).toBe(75);
    // New day: the prior day's count is dropped, then same-day charges add up.
    l = chargeQuota(l, 10, "2026-05-31");
    l = chargeQuota(l, 7, "2026-05-31");
    expect(quotaRemaining(l, "2026-05-31")).toBe(DAILY_CAP - 17);
    // The prior day no longer governs the counter.
    expect(quotaRemaining(l, DAY)).toBe(DAILY_CAP);
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
