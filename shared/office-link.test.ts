import { describe, expect, it } from "vitest";
import { parseInstallationProvisioning } from "./office-link.ts";

// The first-response wire descriptor emitted by managed-gateway/provisioning.ts.
// qa-modelvia-app.mjs additionally passes the actual local gateway response
// through the real desktop HTTP report path, without a fixture projection.
const gatewayDescriptor = () => ({
  version: 1,
  service: { companyId: "fictional-app-company", hostInstallationId: "fixture-installation" },
  connector: { endpoint: "https://fictional-connector.invalid", credential: `rbc_${"a".repeat(64)}`, profile: "property", apps: ["gmail"], projectId: "pr_fictional_app" },
  model: { provider: "modelvia", baseUrl: "https://api.modelvia.dev/v1", projectId: "rb-fixture-installation", key: `rbk_0123456789abcdef_${"A".repeat(43)}`, keyId: "0123456789abcdef", spendCapLabel: "monthly-cap 1000000000 nanoAUD, request-cap 1000000000 nanoAUD, max-concurrent 1" },
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
