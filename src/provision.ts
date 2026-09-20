// pattern: Imperative Shell
// Mints a new case account on our PDS: an admin-issued single-use invite code
// followed by createAccount. Returns the credentials so the caller can log in
// and populate the repo. The handle must be under PDS_SERVICE_HANDLE_DOMAINS
// (.rcape.org); the account exists immediately but its handle only resolves on
// the network once the matching _atproto DNS TXT exists (see dns.ts).

import { randomBytes } from "node:crypto";
import { AtpAgent } from "@atproto/api";
import { DEFAULT_PDS_HOST } from "./caseRepo.js";
import { resolvePdsServiceUrl } from "./pdsService.js";

export interface NewAccount {
  did: string;
  handle: string;
  password: string;
}

// The slice of AtpAgent the provisioner depends on (mockable in tests).
export interface ProvisionClient {
  com: {
    atproto: {
      server: {
        createInviteCode(
          data: { useCount: number },
          opts: { headers: Record<string, string> },
        ): Promise<{ data: { code: string } }>;
        createAccount(data: {
          handle: string;
          email: string;
          password: string;
          inviteCode?: string;
        }): Promise<{ data: { did: string; handle: string } }>;
      };
    };
  };
}

function adminHeaders(adminPassword: string): Record<string, string> {
  const token = Buffer.from(`admin:${adminPassword}`).toString("base64");
  return { authorization: `Basic ${token}` };
}

export function generatePassword(bytes = 18): string {
  return randomBytes(bytes).toString("base64url");
}

export async function createCaseAccount(
  opts: {
    host?: string;
    adminPassword: string;
    handle: string;
    email: string;
    password: string;
  },
  client?: ProvisionClient,
): Promise<NewAccount> {
  const host = opts.host ?? DEFAULT_PDS_HOST;
  const c =
    client ??
    (new AtpAgent({
      // Minting an account is a PDS admin call, so it dials the transport
      // (PDS_SERVICE_URL when set); the handle it creates still lives under the
      // public identity domain. See pdsService.ts.
      service: resolvePdsServiceUrl({
        serviceUrl: process.env.PDS_SERVICE_URL,
        host,
      }),
    }) as unknown as ProvisionClient);

  const invite = await c.com.atproto.server.createInviteCode(
    { useCount: 1 },
    { headers: adminHeaders(opts.adminPassword) },
  );
  const acct = await c.com.atproto.server.createAccount({
    handle: opts.handle,
    email: opts.email,
    password: opts.password,
    inviteCode: invite.data.code,
  });
  return {
    did: acct.data.did,
    handle: acct.data.handle,
    password: opts.password,
  };
}
