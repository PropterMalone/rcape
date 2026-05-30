import { describe, expect, it, vi } from "vitest";
import {
  type ProvisionClient,
  createCaseAccount,
  generatePassword,
} from "./provision.js";

function mockClient(opts: {
  failCreate?: boolean;
}): {
  client: ProvisionClient;
  calls: { invite: unknown[]; account: unknown[] };
} {
  const calls = { invite: [] as unknown[], account: [] as unknown[] };
  const client: ProvisionClient = {
    com: {
      atproto: {
        server: {
          createInviteCode: vi.fn(async (data, o) => {
            calls.invite.push({ data, headers: o.headers });
            return { data: { code: "inv-xyz" } };
          }),
          createAccount: vi.fn(async (data) => {
            calls.account.push(data);
            if (opts.failCreate) throw new Error("Handle already taken");
            return { data: { did: "did:plc:new", handle: data.handle } };
          }),
        },
      },
    },
  };
  return { client, calls };
}

describe("createCaseAccount", () => {
  it("creates an admin invite then an account using it", async () => {
    const { client, calls } = mockClient({});
    const acct = await createCaseAccount(
      {
        adminPassword: "secret",
        handle: "smith.rcape.org",
        email: "case-1@rcape.org",
        password: "pw123",
      },
      client,
    );

    expect(acct).toEqual({
      did: "did:plc:new",
      handle: "smith.rcape.org",
      password: "pw123",
    });
    // invite created with Basic admin auth
    expect(calls.invite).toHaveLength(1);
    expect((calls.invite[0] as { headers: Record<string, string> }).headers.authorization).toMatch(
      /^Basic /,
    );
    // account created with the issued invite code
    expect(calls.account[0]).toMatchObject({
      handle: "smith.rcape.org",
      email: "case-1@rcape.org",
      password: "pw123",
      inviteCode: "inv-xyz",
    });
  });

  it("propagates createAccount failures (e.g. handle taken)", async () => {
    const { client } = mockClient({ failCreate: true });
    await expect(
      createCaseAccount(
        {
          adminPassword: "secret",
          handle: "taken.rcape.org",
          email: "x@rcape.org",
          password: "pw",
        },
        client,
      ),
    ).rejects.toThrow(/Handle already taken/);
  });
});

describe("generatePassword", () => {
  it("returns a non-empty url-safe string that differs each call", () => {
    const a = generatePassword();
    const b = generatePassword();
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.length).toBeGreaterThanOrEqual(20);
    expect(a).not.toBe(b);
  });
});
