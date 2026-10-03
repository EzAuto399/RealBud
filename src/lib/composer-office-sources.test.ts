import { describe, expect, it } from "vitest";
import type { ConnectedAppsStatus, ConnectedService } from "@shared/office-sources";
import { COMPOSER_SOURCE_LABELS, composerOfficeSourceSlugs, composerOfficeSourceState } from "./composer-office-sources";

const service = (patch: Partial<ConnectedService> = {}): ConnectedService => ({ connected: true, status: "ACTIVE", accounts: [{ id: "mail-1", label: "Office mail", status: "ACTIVE" }], accountSelectionRequired: false, ...patch });
const snapshot = (patch: Partial<ConnectedAppsStatus> = {}): ConnectedAppsStatus => ({ configured: true, checkedAt: new Date().toISOString(), services: { gmail: service() }, tools: { available: true, names: ["mail_search"] }, ...patch });

describe("composer connection availability", () => {
  it("only describes verified usable access as available", () => {
    expect(composerOfficeSourceState(snapshot(), "gmail", null, "")).toBe("ready");
    const cases: [ConnectedAppsStatus, string | null, string, string][] = [
      [snapshot({ checkedAt: new Date(Date.now() - 600_000).toISOString() }), null, "", "unchecked"],
      [snapshot({ tools: { available: false, names: [] } }), null, "", "degraded"],
      [snapshot({ services: { gmail: service({ accountSelectionRequired: true }) } }), null, "", "choose-account"],
      [snapshot({ excludedApps: ["gmail"] }), null, "", "excluded"],
      [snapshot(), "gmail", "", "signing-in"],
      [snapshot(), null, "Connection check failed", "degraded"],
    ];
    for (const [access, pending, error, expected] of cases) {
      const state = composerOfficeSourceState(access, "gmail", pending, error);
      expect(state).toBe(expected);
      expect(COMPOSER_SOURCE_LABELS[state]).not.toBe("Available");
    }
  });

  it("keeps expired and revoked accounts reachable for recovery, without listing unused apps", () => {
    expect(composerOfficeSourceSlugs(snapshot({ services: {
      gmail: service(),
      outlook: service({ connected: false, status: "EXPIRED", accounts: [] }),
      googledrive: service({ connected: false, status: "REVOKED", accounts: [] }),
      notion: service({ connected: false, status: "DISCONNECTED", accounts: [] }),
    } }), null)).toEqual(["gmail", "outlook", "googledrive"]);
  });

  it("shows pending sign-in before the service appears in the response, without duplicates", () => {
    expect(composerOfficeSourceSlugs(null, "gmail")).toEqual(["gmail"]);
    expect(composerOfficeSourceSlugs(snapshot(), "gmail")).toEqual(["gmail"]);
    expect(composerOfficeSourceState(null, "gmail", "gmail", "")).toBe("signing-in");
  });

  it("offers recovery when connection evidence has no selectable active accounts", () => {
    for (const accounts of [[], [{ id: "old-account", status: "REVOKED" }]]) {
      expect(composerOfficeSourceState(snapshot({ services: { gmail: service({ accounts }) } }), "gmail", null, "")).toBe("degraded");
    }
  });

  it("does not invent enable progress for an excluded, disconnected source", () => {
    const access = snapshot({ excludedApps: ["gmail"], services: { gmail: service({ connected: false, status: "REVOKED" }) } });
    expect(COMPOSER_SOURCE_LABELS[composerOfficeSourceState(access, "gmail", null, "")]).toBe("Not available in Ask");
  });
});
