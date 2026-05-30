import { describe, expect, it } from "vitest";
import {
  type Ledger,
  chargeQuota,
  emptyLedger,
  findCase,
  quotaRemaining,
  recordCase,
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
});
