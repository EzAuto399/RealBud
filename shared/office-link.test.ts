import { describe, expect, it } from "vitest";
import { currentUsagePeriod, parseInstallationProvisioning, type InstallationProvisioning } from "./office-link.ts";

// The first-response wire descriptor emitted by managed-gateway/provisioning.ts,
// with the label a gateway from before 25 September 2026 wrote (82 characters,
// which the desktop must keep accepting). server/installation-provisioning-
// contract.test.ts builds today's descriptor with the gateway's own code.
// qa-modelvia-app.mjs additionally passes the actual local gateway response
// through the real desktop HTTP report path, without a fixture projection.
const gatewayDescriptor = () => ({
  version: 1,
  service: { companyId: "fictional-app-company", hostInstallationId: "fixture-installation" },
  connector: { endpoint: "https://fictional-connector.invalid", credential: `rbc_${"a".repeat(64)}`, profile: "property", apps: ["gmail"], projectId: "pr_fictional_app" },
  model: { provider: "modelvia", baseUrl: "https://api.modelvia.dev/v1", projectId: "rb-fixture-installation", key: `rbk_0123456789abcdef_${"A".repeat(43)}`, keyId: "0123456789abcdef", spendCapLabel: "monthly-cap 1000000000 nanoAUD, request-cap 1000000000 nanoAUD, max-concurrent 1" },
});

describe("usage accounting month", () => {
  it.each([
    ["2026-09-30T13:59:59.999Z", "2026-09"],
    ["2026-09-30T14:00:00.000Z", "2026-10"],
    ["2026-12-31T14:00:00.000Z", "2027-01"],
    ["2028-02-29T14:00:00.000Z", "2028-03"],
  ])("uses the same Brisbane month as the portal at %s", (instant, period) => {
    expect(currentUsagePeriod(new Date(instant))).toBe(period);
  });
});

describe("gateway installation descriptor compatibility", () => {
  it("accepts the gateway's connector project metadata without granting it to the local worker", () => {
    const source = gatewayDescriptor();
    const parsed = parseInstallationProvisioning(source);
    expect(parsed?.model).toEqual(source.model);
    expect(parsed?.connector).toEqual({ endpoint: source.connector.endpoint, credential: source.connector.credential, profile: "property", apps: ["gmail"] });
    expect(source.connector.projectId).toBe("pr_fictional_app");
  });
  it("keeps the earlier descriptor without connector project metadata compatible", () => {
    const { projectId: _metadata, ...connector } = gatewayDescriptor().connector;
    expect(parseInstallationProvisioning({ ...gatewayDescriptor(), connector })?.connector).toEqual(connector);
  });
  it.each([undefined, null, "", "contains spaces", "../outside", "x".repeat(129), 42, {}, []])("rejects malformed present connector project metadata: %j", projectId => {
    const source = gatewayDescriptor();
    expect(() => parseInstallationProvisioning({ ...source, connector: { ...source.connector, projectId } })).toThrow(/cannot accept/);
  });
  it("still rejects additional connector keys, missing scoped credentials and vendor keys", () => {
    const source = gatewayDescriptor();
    expect(() => parseInstallationProvisioning({ ...source, connector: { ...source.connector, admin: true } })).toThrow(/cannot accept/);
    const { credential: _secret, ...connector } = source.connector;
    expect(() => parseInstallationProvisioning({ ...source, connector })).toThrow(/cannot accept/);
    expect(() => parseInstallationProvisioning({ ...source, connector: { ...source.connector, projectId: `ak_${"x".repeat(32)}` } })).toThrow(/vendor key/);
  });
});

describe("spend cap label", () => {
  const withLabel = (spendCapLabel: unknown) => { const source = gatewayDescriptor(); return { ...source, model: { ...source.model, spendCapLabel } }; };
  it("accepts today's short gateway label, the older 82-character one, and anything printable up to 160", () => {
    // The A$200 default as a gateway from before 25 September 2026 labelled it: 82 characters.
    const older = "monthly-cap 200000000000 nanoAUD, request-cap 1000000000 nanoAUD, max-concurrent 2";
    expect(older.length).toBe(82);
    for (const label of ["A$200/month, A$1/request, 2 at once", "A$10,000/month, A$0.50/request, 100 at once", older, gatewayDescriptor().model.spendCapLabel, "x".repeat(160)]) {
      expect((parseInstallationProvisioning(withLabel(label)) as InstallationProvisioning).model.spendCapLabel).toBe(label);
    }
  });
  it.each(["", "x".repeat(161), "A$200/month · A$1/request", "line\nbreak", 42, null])("refuses a label that is not printable ASCII within bounds: %j", label => {
    expect(() => parseInstallationProvisioning(withLabel(label))).toThrow(/cannot accept/);
  });
});
