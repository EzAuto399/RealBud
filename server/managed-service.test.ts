import { afterEach, describe, expect, it } from "vitest";
import { tryHermesLedger, tryHermesPing } from "./hermes-hands.ts";
import { askWorker } from "./recipe-draft.ts";
import { inspectLedgerColumns } from "./import-inspect.ts";
import { cliEnvironment } from "./procs.ts";

afterEach(() => { delete process.env.REALBUD_MANAGED_SERVICE; });

describe("managed service failure recovery contracts", () => {
  it("returns held/failure results rather than orphaning a persisted preparation run", async () => {
    process.env.REALBUD_MANAGED_SERVICE = "1";
    await expect(askWorker("synthetic preparation")).resolves.toMatchObject({ ok: false, detail: expect.stringContaining("provisioning") });
    await expect(tryHermesPing()).resolves.toMatchObject({ ok: false, detail: expect.stringContaining("provisioning") });
    await expect(tryHermesLedger([])).resolves.toMatchObject({ rows: null, detail: expect.stringContaining("provisioning") });
    await expect(inspectLedgerColumns("address,amount\nFixture,10")).resolves.toMatchObject({ mapping: null, detail: expect.stringContaining("provisioning") });
  });

  it("strips trusted host secrets through the actual CLI environment boundary", () => {
    const source = { PATH: "/synthetic/bin", REALBUD_CARE_UNLOCK: "fixture-secret", REALBUD_SERVICE_ADMIN_FILE: "/private/policy",
      REALBUD_COMPANY_DATABASE_URL: "fixture-db", PGPASSWORD: "fixture-password", REALBUD_CUA_CONTROL_TOKEN: "fixture-token" };
    expect(cliEnvironment(source)).toEqual({ PATH: "/synthetic/bin" });
    expect(source.REALBUD_CARE_UNLOCK).toBe("fixture-secret");
  });
});
