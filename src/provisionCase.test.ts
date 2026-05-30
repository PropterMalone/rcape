import { describe, expect, it } from "vitest";
import { parseDocketId } from "./provisionCase.js";

describe("parseDocketId", () => {
  it("accepts a bare numeric id", () => {
    expect(parseDocketId("69777799")).toBe(69777799);
  });

  it("extracts the id from a CourtListener docket URL", () => {
    expect(
      parseDocketId(
        "https://www.courtlistener.com/docket/69777799/abrego-garcia-v-noem/",
      ),
    ).toBe(69777799);
  });

  it("returns null for undefined or non-docket input", () => {
    expect(parseDocketId(undefined)).toBeNull();
    expect(parseDocketId("not-a-docket")).toBeNull();
  });
});
