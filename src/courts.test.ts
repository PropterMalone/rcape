import { describe, expect, it } from "vitest";
import { courtLabel } from "./courts.js";

describe("courtLabel", () => {
  it("maps known federal court ids to their CourtListener citation string", () => {
    expect(courtLabel("ilnd")).toBe("N.D. Ill."); // Broadview Six case court
    expect(courtLabel("nysd")).toBe("S.D.N.Y.");
    expect(courtLabel("ca9")).toBe("9th Cir.");
  });

  it("falls back to the raw court_id for an unmapped court", () => {
    expect(courtLabel("totally-not-a-court")).toBe("totally-not-a-court");
  });
});
