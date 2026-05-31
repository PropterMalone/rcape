import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MappedCase } from "./build.js";
import type { CourtListenerClient } from "./courtlistener.js";
import { emptyLedger, loadLedger, saveLedger } from "./ledger.js";
import { type ProvisionConfig, runProvision } from "./provisionCase.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rcape-provision-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function cfg(ledgerPath: string): ProvisionConfig {
  return {
    token: "t",
    domain: "rcape.org",
    hashN: 0,
    adminPassword: "",
    cfToken: "",
    zoneId: "",
    ledgerPath,
  };
}

// A client stub that only reports a fixed requestCount — the single field
// runProvision reads for quota accounting.
function clientWithCount(n: number): CourtListenerClient {
  return { requestCount: n } as unknown as CourtListenerClient;
}

const DAY = new Date().toISOString().slice(0, 10);

describe("runProvision incremental quota", () => {
  it("persists the reservation BEFORE fetch resolves, so a true crash mid-fetch still shows spend", async () => {
    const ledgerPath = join(dir, "ledger.json");
    await saveLedger(ledgerPath, emptyLedger());

    const SPENT = 9; // calls CL already counted at the crash point
    // Observe the durable ledger AT the moment the fetch is in flight (before it
    // resolves or rejects, i.e. before any catch-reconcile could run). A true
    // process crash here would persist whatever was already on disk. The old
    // code charged nothing until after fetchAndMapCase resolved, so this read
    // would have seen 0; the reservation makes it >= the calls already spent.
    let durableAtCrash = -1;
    const result = await runProvision(123, cfg(ledgerPath), {
      makeClient: () => clientWithCount(SPENT),
      mapCase: async () => {
        durableAtCrash = (await loadLedger(ledgerPath)).quota.count;
        throw new Error("simulated crash mid-fetch");
      },
    });
    expect(result.status).toBe("error");

    // The reservation was on disk while the fetch was running — not 0.
    expect(durableAtCrash).toBeGreaterThanOrEqual(SPENT);

    // After the catch reconciles, the durable counter reflects the real spend.
    const ledger = await loadLedger(ledgerPath);
    expect(ledger.quota.day).toBe(DAY);
    expect(ledger.quota.count).toBeGreaterThanOrEqual(SPENT);
  });

  it("reconciles down to the real call count on a successful fetch", async () => {
    const ledgerPath = join(dir, "ledger.json");
    await saveLedger(ledgerPath, emptyLedger());

    const ACTUAL = 13;
    // mapCase resolves with the minimum shape recordCase/handle derivation need,
    // then dry-run short-circuits before any account/DNS/repo I/O.
    const result = await runProvision(123, cfg(ledgerPath), {
      dryRun: true,
      makeClient: () => clientWithCount(ACTUAL),
      // Minimal shape: only caseName/docketNumber (handle derivation) and the
      // empty record arrays (dry-run counts) are read before the short-circuit.
      mapCase: async () =>
        ({
          docketRecord: { caseName: "Doe v. Roe", docketNumber: "1:23-cv-1" },
          entryRecords: [],
          parties: [],
          records: [],
        }) as unknown as MappedCase,
    });
    expect(result.status).toBe("dry-run");

    const ledger = await loadLedger(ledgerPath);
    // Reservation (17) reconciled down to the actual 13 calls.
    expect(ledger.quota.count).toBe(ACTUAL);
  });
});
