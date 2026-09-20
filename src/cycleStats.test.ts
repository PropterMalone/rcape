import { describe, expect, it } from "vitest";
import {
  type CycleStats,
  DEFAULT_CYCLE_WINDOW,
  appendCycleOutcome,
  parseWindow,
} from "./cycleStats.js";

const T = (n: number) => `2026-09-20T12:${String(n).padStart(2, "0")}:00.000Z`;

// Build a window by replaying outcomes through the function under test, so the
// fixture can't drift from the shape the function actually produces.
function replay(oks: boolean[], window?: number): CycleStats {
  let stats: CycleStats | null = null;
  oks.forEach((ok, i) => {
    stats = appendCycleOutcome(stats, ok, T(i), window);
  });
  if (stats === null) throw new Error("replay needs at least one outcome");
  return stats;
}

describe("parseWindow", () => {
  it("defaults when unset or malformed — a NaN window would silently empty the slice", () => {
    for (const raw of [undefined, "", "abc", "0", "-5", "3.5", "NaN"]) {
      expect(parseWindow(raw)).toBe(DEFAULT_CYCLE_WINDOW);
    }
  });

  it("accepts a positive integer", () => {
    expect(parseWindow("25")).toBe(25);
  });
});

describe("appendCycleOutcome", () => {
  it("starts a window from nothing", () => {
    const s = appendCycleOutcome(null, true, T(0));
    expect(s).toMatchObject({ total: 1, failures: 0, updatedAt: T(0) });
    expect(s.recent).toEqual([{ at: T(0), ok: true }]);
  });

  it("counts failures across the window", () => {
    expect(replay([true, false, false, true])).toMatchObject({
      total: 4,
      failures: 2,
    });
  });

  it("caps at the window, dropping oldest first", () => {
    const s = replay([false, false, true, true, true], 3);
    expect(s.total).toBe(3);
    // The two leading failures aged out; only successes remain.
    expect(s.failures).toBe(0);
    expect(s.recent.map((o) => o.at)).toEqual([T(2), T(3), T(4)]);
  });

  it("a shrunk window takes effect on the next write", () => {
    const wide = replay([false, false, false, false], 10);
    expect(wide.total).toBe(4);
    const narrow = appendCycleOutcome(wide, true, T(9), 2);
    expect(narrow).toMatchObject({ window: 2, total: 2, failures: 1 });
  });

  it("derived counts always agree with recent (the source of truth)", () => {
    const s = replay([true, false, true, false, false], 4);
    expect(s.total).toBe(s.recent.length);
    expect(s.failures).toBe(s.recent.filter((o) => !o.ok).length);
  });

  // The file is read back off disk, so a truncated write or a hand-edit must
  // degrade to a fresh window rather than throw inside the poll loop.
  it("recovers from a corrupt prior instead of throwing", () => {
    const junk = { recent: "not-an-array" } as unknown as CycleStats;
    expect(appendCycleOutcome(junk, false, T(1))).toMatchObject({
      total: 1,
      failures: 1,
    });
  });

  it("drops malformed entries but keeps the good ones", () => {
    const mixed = {
      recent: [{ at: T(0), ok: true }, { nope: 1 }, { at: 5, ok: false }],
    } as unknown as CycleStats;
    const s = appendCycleOutcome(mixed, false, T(1));
    expect(s.total).toBe(2);
    expect(s.failures).toBe(1);
  });
});

// Regression for the wrap /angel finding: the rate signal must not be able to
// die permanently. bot.recordCycleOutcome catches the unreadable-state throw and
// starts fresh; this covers the pure half — a fresh window is well-formed.
describe("recovery after an unreadable window", () => {
  it("a fresh window built from null is immediately valid", () => {
    const s = appendCycleOutcome(null, false, T(0), 10);
    expect(s).toMatchObject({ window: 10, total: 1, failures: 1 });
    expect(s.recent).toHaveLength(1);
  });
});
