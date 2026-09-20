import { describe, expect, it } from "vitest";
import { resolvePdsServiceUrl } from "./pdsService.js";

const HOST = "pds.rcape.org";

describe("resolvePdsServiceUrl", () => {
  it("falls back to the public host when no override is set", () => {
    expect(resolvePdsServiceUrl({ host: HOST })).toBe("https://pds.rcape.org");
  });

  it("treats a blank override as unset (PDS_SERVICE_URL= is a common .env shape)", () => {
    expect(resolvePdsServiceUrl({ serviceUrl: "", host: HOST })).toBe(
      "https://pds.rcape.org",
    );
    expect(resolvePdsServiceUrl({ serviceUrl: "   ", host: HOST })).toBe(
      "https://pds.rcape.org",
    );
  });

  it("uses a loopback override verbatim — the whole point of the setting", () => {
    expect(
      resolvePdsServiceUrl({
        serviceUrl: "http://127.0.0.1:2583",
        host: HOST,
      }),
    ).toBe("http://127.0.0.1:2583");
  });

  it("accepts an https override (a different PDS, not just loopback)", () => {
    expect(
      resolvePdsServiceUrl({
        serviceUrl: "https://pds.other.test",
        host: HOST,
      }),
    ).toBe("https://pds.other.test");
  });

  it("strips trailing slashes so the value is stable across call sites", () => {
    expect(
      resolvePdsServiceUrl({
        serviceUrl: "http://127.0.0.1:2583/",
        host: HOST,
      }),
    ).toBe("http://127.0.0.1:2583");
  });

  // This test previously asserted that a path prefix was PRESERVED, which was a
  // guarantee the code could not keep: @atproto/xrpc calls `/xrpc/<nsid>` as an
  // absolute path against the base, so the prefix never reached the wire. An
  // assertion of a false promise is worse than no assertion — refuse the input.
  it("refuses a path prefix instead of promising to honour one", () => {
    expect(() =>
      resolvePdsServiceUrl({
        serviceUrl: "http://127.0.0.1:2583/pds",
        host: HOST,
      }),
    ).toThrow(/must not carry a path/);
  });

  it("a bare trailing slash is a path-less URL, not a prefix", () => {
    expect(
      resolvePdsServiceUrl({
        serviceUrl: "http://127.0.0.1:2583/",
        host: HOST,
      }),
    ).toBe("http://127.0.0.1:2583");
  });

  it("allows plaintext to loopback and private ranges", () => {
    for (const h of [
      "127.0.0.1:2583",
      "localhost:2583",
      "10.0.0.5:2583",
      "192.168.1.9:2583",
      "172.16.0.2:2583",
    ]) {
      expect(
        resolvePdsServiceUrl({ serviceUrl: `http://${h}`, host: HOST }),
      ).toBe(`http://${h}`);
    }
  });

  it("refuses plaintext to a public host — that would ship session tokens in the clear", () => {
    expect(() =>
      resolvePdsServiceUrl({ serviceUrl: "http://pds.rcape.org", host: HOST }),
    ).toThrow(/only use http:\/\/ for a loopback/);
    // 172.15 and 172.32 sit outside the private block and must not slip through.
    expect(() =>
      resolvePdsServiceUrl({
        serviceUrl: "http://172.15.0.1:2583",
        host: HOST,
      }),
    ).toThrow(/loopback/);
    expect(() =>
      resolvePdsServiceUrl({
        serviceUrl: "http://172.32.0.1:2583",
        host: HOST,
      }),
    ).toThrow(/loopback/);
  });

  it("surrounding whitespace does not defeat the override", () => {
    expect(
      resolvePdsServiceUrl({
        serviceUrl: "  http://127.0.0.1:2583  ",
        host: HOST,
      }),
    ).toBe("http://127.0.0.1:2583");
  });

  // A malformed override must THROW, never fall back to `https://${host}`: the
  // fallback is the hairpin this setting exists to avoid, so a silent one would
  // restore the outage while looking configured.
  it("throws on a scheme-less value instead of falling back to the public host", () => {
    expect(() =>
      resolvePdsServiceUrl({ serviceUrl: "127.0.0.1:2583", host: HOST }),
    ).toThrow(/PDS_SERVICE_URL/);
  });

  it("throws on a non-http scheme", () => {
    expect(() =>
      resolvePdsServiceUrl({ serviceUrl: "ftp://127.0.0.1", host: HOST }),
    ).toThrow(/PDS_SERVICE_URL/);
  });

  it("throws on a scheme with no authority", () => {
    expect(() =>
      resolvePdsServiceUrl({ serviceUrl: "http://", host: HOST }),
    ).toThrow(/PDS_SERVICE_URL/);
  });
});
