import { describe, expect, it } from "vitest";
import { prune } from "./repo.js";

describe("prune", () => {
  it("removes undefined values from a flat object", () => {
    expect(prune({ a: undefined })).toEqual({});
  });

  it("removes undefined values from nested objects", () => {
    expect(prune({ a: { b: undefined } })).toEqual({ a: {} });
  });

  it("removes undefined values inside arrays", () => {
    expect(prune([{ x: undefined }])).toEqual([{}]);
  });

  it("keeps null values", () => {
    expect(prune({ a: null })).toEqual({ a: null });
  });
});
