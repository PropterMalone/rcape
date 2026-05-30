import { describe, expect, it } from "vitest";
import { cidForBytes } from "./cid.js";

describe("cidForBytes", () => {
  it("is deterministic and a CIDv1 raw multihash (bafkrei…)", async () => {
    const bytes = new TextEncoder().encode("hello cranch");
    const a = await cidForBytes(bytes);
    const b = await cidForBytes(bytes);
    expect(a).toBe(b);
    expect(a.startsWith("bafkrei")).toBe(true);
  });

  it("differs for different bytes", async () => {
    const a = await cidForBytes(new TextEncoder().encode("a"));
    const b = await cidForBytes(new TextEncoder().encode("b"));
    expect(a).not.toBe(b);
  });
});
