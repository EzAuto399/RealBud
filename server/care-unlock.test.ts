import { afterEach, describe, expect, it } from "vitest";
import { careCredentialsLocked, careStatus } from "./care-unlock.ts";
afterEach(() => {
  delete process.env.REALBUD_MANAGED_SERVICE;
  delete process.env.REALBUD_CARE_UNLOCK;
  delete process.env.REALBUD_CARE_LOCK;
});
describe("care compatibility without a global unlock", () => {
  it("keeps an unprovisioned development checkout separate from a managed installation", () => {
    expect(careCredentialsLocked()).toBe(false);
    expect(careStatus()).toEqual({ credentialsLocked: false, unlockAvailable: false });
    process.env.REALBUD_MANAGED_SERVICE = "1";
    expect(careStatus()).toEqual({ credentialsLocked: true, unlockAvailable: false });
  });
  it("does not turn missing or legacy care configuration into unrestricted managed access", () => {
    process.env.REALBUD_CARE_UNLOCK = "legacy-provisioning-must-be-migrated";
    process.env.REALBUD_CARE_LOCK = "0";
    expect(careCredentialsLocked()).toBe(true);
    expect(careStatus().unlockAvailable).toBe(false);
  });
});
