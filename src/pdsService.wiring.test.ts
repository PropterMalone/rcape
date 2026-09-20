import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every local AtpAgent must dial the TRANSPORT url, not the public identity
// host. The resolver being correct is worth nothing if a call site never calls
// it, so this file mocks @atproto/api and asserts the `service` each of the
// three construction sites actually hands the agent.
const constructed = vi.hoisted(() => [] as string[]);

vi.mock("@atproto/api", () => {
  class FakeAtpAgent {
    session?: { did: string; handle: string };
    com = {
      atproto: {
        server: {
          createInviteCode: async () => ({ data: { code: "invite-1" } }),
          createAccount: async (p: { handle: string }) => ({
            data: { did: "did:plc:new", handle: p.handle },
          }),
        },
      },
    };
    constructor(opts: { service: string }) {
      constructed.push(opts.service);
    }
    async login(): Promise<void> {
      this.session = { did: "did:plc:bot", handle: "ape.rcape.org" };
    }
  }
  return { AtpAgent: FakeAtpAgent };
});

const { createBotAgent } = await import("./botAgent.js");
const { CaseRepo } = await import("./caseRepo.js");
const { createCaseAccount } = await import("./provision.js");

// NOT `process.env.X = undefined`: assigning to process.env coerces, leaving the
// literal string "undefined" behind — which the resolver would then reject as a
// scheme-less override, passing this test for entirely the wrong reason.
function unsetServiceUrl(): void {
  Reflect.deleteProperty(process.env, "PDS_SERVICE_URL");
}

const CREDS = { identifier: "did:plc:bot", password: "pw" };
const ACCOUNT = {
  adminPassword: "admin",
  handle: "x.rcape.org",
  email: "x@rcape.org",
  password: "pw",
};

describe("PDS transport wiring", () => {
  const saved = process.env.PDS_SERVICE_URL;
  beforeEach(() => {
    constructed.length = 0;
  });
  afterEach(() => {
    if (saved === undefined) unsetServiceUrl();
    else process.env.PDS_SERVICE_URL = saved;
  });

  it("dials the loopback override from every construction site", async () => {
    process.env.PDS_SERVICE_URL = "http://127.0.0.1:2583";
    await createBotAgent({ host: "pds.rcape.org", ...CREDS });
    await CaseRepo.login({ host: "pds.rcape.org", ...CREDS });
    await createCaseAccount({ host: "pds.rcape.org", ...ACCOUNT });
    expect(constructed).toEqual([
      "http://127.0.0.1:2583",
      "http://127.0.0.1:2583",
      "http://127.0.0.1:2583",
    ]);
  });

  it("falls back to the public host when the override is unset", async () => {
    unsetServiceUrl();
    await createBotAgent({ host: "pds.rcape.org", ...CREDS });
    await CaseRepo.login({ host: "pds.rcape.org", ...CREDS });
    await createCaseAccount({ host: "pds.rcape.org", ...ACCOUNT });
    expect(constructed).toEqual([
      "https://pds.rcape.org",
      "https://pds.rcape.org",
      "https://pds.rcape.org",
    ]);
  });

  it("still honours the default host when neither host nor override is given", async () => {
    unsetServiceUrl();
    await createBotAgent(CREDS);
    expect(constructed).toEqual(["https://pds.rcape.org"]);
  });

  it("a malformed override fails loudly instead of hairpinning", async () => {
    process.env.PDS_SERVICE_URL = "127.0.0.1:2583";
    await expect(createBotAgent(CREDS)).rejects.toThrow(/PDS_SERVICE_URL/);
    expect(constructed).toEqual([]);
  });
});
