import { describe, expect, it } from "vitest";
import { uriToTarget } from "./takedown.js";

describe("uriToTarget", () => {
  it("parses a valid at:// URI into collection and rkey", () => {
    const result = uriToTarget(
      "at://did:plc:abc123/org.rcape.docketEntry/3kexample",
    );
    expect(result).toEqual({
      collection: "org.rcape.docketEntry",
      rkey: "3kexample",
    });
  });

  it("returns null for a malformed URI", () => {
    expect(uriToTarget("not-an-at-uri")).toBeNull();
    expect(uriToTarget("at://did:plc:abc123")).toBeNull();
    expect(uriToTarget("at://did:plc:abc123/only-one-segment")).toBeNull();
  });
});
