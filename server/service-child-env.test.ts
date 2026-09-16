import { describe, expect, it } from "vitest";
import { serviceSafeChildEnv, stripServiceSecrets } from "./service-child-env.ts";

describe("trusted host secrets at child-process boundaries", () => {
  it("removes administration, database and connector credentials including future namespaced values", () => {
    const env: NodeJS.ProcessEnv = {
      REALBUD_CARE_UNLOCK: "private-care-value",
      REALBUD_SERVICE_ADMIN_TOKEN: "private-admin-value",
      REALBUD_COMPANY_DATABASE_URL: "private-database-value",
      REALBUD_ENTITLEMENT_SIGNING_KEY: "private-signing-value",
      REALBUD_BILLING_SECRET: "private-billing-value",
      PGPASSWORD: "private-password", PGHOST: "private-host", PGOPTIONS: "private-options",
      DATABASE_URL: "private-url", COMPOSIO_API_KEY: "private-connector",
      PATH: "/bin", HERMES_HOME: "/work/private-context", HERMES_SAFE_MODE: "1",
    };
    stripServiceSecrets(env);
    expect(env).toEqual({ PATH: "/bin", HERMES_HOME: "/work/private-context", HERMES_SAFE_MODE: "1" });
  });

  it("does not allow per-child overrides to reintroduce service secrets", () => {
    const env = serviceSafeChildEnv({ REALBUD_SERVICE_PASSWORD: "must-not-escape", HERMES_HOME: "/assigned" });
    expect(env.REALBUD_SERVICE_PASSWORD).toBeUndefined();
    expect(env.HERMES_HOME).toBe("/assigned");
  });
});
