import { describe, expect, it } from "vitest";
import {
  type LexiconDoc,
  buildSchemaRecord,
  lexiconAuthorityDomain,
} from "./lexiconSchema.js";

const doc: LexiconDoc = {
  lexicon: 1,
  id: "org.rcape.docket",
  defs: { main: { type: "record" } },
};

describe("buildSchemaRecord", () => {
  it("tags the lexicon doc with the schema record $type, preserving its fields", () => {
    const rec = buildSchemaRecord(doc);
    expect(rec.$type).toBe("com.atproto.lexicon.schema");
    expect(rec.lexicon).toBe(1);
    expect(rec.id).toBe("org.rcape.docket");
    expect(rec.defs).toEqual({ main: { type: "record" } });
  });
});

describe("lexiconAuthorityDomain", () => {
  it("reverses the NSID authority (all segments but the name) into a domain", () => {
    expect(lexiconAuthorityDomain("org.rcape.docket")).toBe("rcape.org");
    expect(lexiconAuthorityDomain("org.rcape.docketEntry")).toBe("rcape.org");
    expect(lexiconAuthorityDomain("com.example.thing")).toBe("example.com");
    // 4-segment NSID: the name is the final segment, so the authority includes
    // the sub-namespace (drop-last, reversed) — matches the publishing guide's
    // per-prefix _lexicon records. Our org.rcape.* NSIDs are all 3-segment.
    expect(lexiconAuthorityDomain("app.toy.like.record")).toBe("like.toy.app");
  });

  it("throws on an NSID with no authority", () => {
    expect(() => lexiconAuthorityDomain("foo.bar")).toThrow(/authority/);
  });
});
