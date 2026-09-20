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

  it("preserves a path prefix rather than silently dropping it", () => {
    expect(
      resolvePdsServiceUrl({
        serviceUrl: "http://127.0.0.1:2583/pds",
        host: HOST,
      }),
    ).toBe("http://127.0.0.1:2583/pds");
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
