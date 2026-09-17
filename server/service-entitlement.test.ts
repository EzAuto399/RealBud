import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  assertServiceEntitlementCapability, canonicalServiceEntitlementPayload, createServiceEntitlementAuthority,
  readServiceEntitlement, type ServiceEntitlementOptions,
} from "./service-entitlement.ts";
import type { ServiceEntitlementCapability, ServiceEntitlementPayload } from "../shared/service-entitlement.ts";

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60_000;
const COMPANY = "company-fixture";
const HOST = "host-fixture";
let scratch: string;
let options: ServiceEntitlementOptions;
let privateKey: KeyObject;
let publicKeyPem: string;
let secondPrivateKey: KeyObject;
let secondPublicKeyPem: string;
let counter = 0;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "realbud-entitlement-test-"));
  const first = generateKeyPairSync("ed25519"), second = generateKeyPairSync("ed25519");
  privateKey = first.privateKey;
  publicKeyPem = first.publicKey.export({ type: "spki", format: "pem" }).toString();
  secondPrivateKey = second.privateKey;
  secondPublicKeyPem = second.publicKey.export({ type: "spki", format: "pem" }).toString();
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
beforeEach(() => {
  counter++;
  options = { managed: true, path: join(scratch, `grant-${counter}.json`), trustedKeysPath: join(scratch, `trust-${counter}.json`),
    companyId: COMPANY, hostInstallationId: HOST, now: NOW };
  writeTrust();
});

function payload(patch: Partial<ServiceEntitlementPayload> = {}): ServiceEntitlementPayload {
  return { schema: 1, licenseId: "license-fixture-private-reference", companyId: COMPANY, hostInstallationId: HOST,
    issuedAt: NOW - DAY, notBefore: NOW - DAY, expiresAt: NOW + DAY, capabilities: ["reasoning", "connected-tools", "computer-use", "voice"], ...patch };
}

function writeTrust(keys = [{ keyId: "issuer-one", publicKeyPem }]) {
  writeFileSync(options.trustedKeysPath, JSON.stringify({ schema: 1, keys }));
}

function signed(payloadText: string, keyId = "issuer-one", key = privateKey) {
  return { schema: 1, keyId, payload: payloadText, signature: sign(null, Buffer.from(payloadText, "utf8"), key).toString("base64url") };
}

function writeGrant(value = payload()) {
  writeFileSync(options.path, JSON.stringify(signed(canonicalServiceEntitlementPayload(value))));
}

function writeSignedPayload(value: unknown) {
  const shaped = value && typeof value === "object" && !Array.isArray(value) && "capabilities" in value && Array.isArray(value.capabilities)
    ? { ...value, capabilities: [...value.capabilities].sort() } : value;
  writeFileSync(options.path, JSON.stringify(signed(typeof value === "string" ? value : JSON.stringify(shaped))));
}

describe("signed entitlement admission", () => {
  it("admits an exact Ed25519 grant only for its provisioned company and host", () => {
    writeGrant();
    expect(readServiceEntitlement(options)).toEqual({ state: "active", managed: true, required: true,
      capabilities: ["computer-use", "connected-tools", "reasoning", "voice"], expiresAt: NOW + DAY, error: null });
    for (const capability of ["reasoning", "connected-tools", "computer-use", "voice"] as const) {
      expect(() => assertServiceEntitlementCapability(capability, options)).not.toThrow();
    }
  });

  it("rejects another company or host and never infers expected binding from the payload", () => {
    writeGrant();
    expect(readServiceEntitlement({ ...options, companyId: "other-company" }).state).toBe("invalid");
    expect(readServiceEntitlement({ ...options, hostInstallationId: "other-host" }).state).toBe("invalid");
    expect(readServiceEntitlement({ ...options, companyId: undefined }).state).toBe("unconfigured");
    expect(readServiceEntitlement({ ...options, hostInstallationId: undefined }).state).toBe("unconfigured");
  });

  it("defaults managed installations to required and permits explicit trusted development policies", () => {
    expect(readServiceEntitlement(options).state).toBe("unconfigured");
    expect(() => assertServiceEntitlementCapability("reasoning", options)).toThrow(expect.objectContaining({ status: 402 }));
    expect(readServiceEntitlement({ ...options, managed: false }).state).toBe("unmanaged");
    expect(readServiceEntitlement({ ...options, required: false }).state).toBe("not-required");
    expect(() => assertServiceEntitlementCapability("reasoning", { ...options, managed: false })).not.toThrow();
    expect(() => assertServiceEntitlementCapability("reasoning", { ...options, required: false })).not.toThrow();
  });

  it("rejects malformed policy flags rather than treating them as false", () => {
    expect(readServiceEntitlement({ ...options, managed: "false" } as unknown as ServiceEntitlementOptions).state).toBe("invalid");
    expect(readServiceEntitlement({ ...options, required: "false" } as unknown as ServiceEntitlementOptions).state).toBe("invalid");
  });

  it("verifies exact signed bytes and rejects tampering", () => {
    const envelope = signed(canonicalServiceEntitlementPayload(payload({ capabilities: ["reasoning"] })));
    envelope.payload = canonicalServiceEntitlementPayload(payload());
    writeFileSync(options.path, JSON.stringify(envelope));
    expect(readServiceEntitlement(options).state).toBe("invalid");
    expect(() => assertServiceEntitlementCapability("reasoning", options)).toThrow(expect.objectContaining({ status: 403 }));
  });

  it("rejects a grant signed with an untrusted key and an unknown key ID", () => {
    const body = canonicalServiceEntitlementPayload(payload());
    writeFileSync(options.path, JSON.stringify(signed(body, "issuer-one", secondPrivateKey)));
    expect(readServiceEntitlement(options).state).toBe("invalid");
    writeFileSync(options.path, JSON.stringify(signed(body, "unknown-issuer")));
    expect(readServiceEntitlement(options).state).toBe("invalid");
  });

  it("requires canonical payload formatting even for an otherwise valid signature", () => {
    for (const body of [JSON.stringify(payload(), null, 2), JSON.stringify(payload()),
      canonicalServiceEntitlementPayload(payload()).replace('"schema":1', '"schema":1,"schema":1')]) {
      writeSignedPayload(body);
      expect(readServiceEntitlement(options).state).toBe("invalid");
    }
  });

  it("does not trust key material, algorithm or policy supplied inside the grant", () => {
    for (const extra of [{ publicKeyPem: secondPublicKeyPem }, { alg: "none" }, { managed: false }, { required: false }]) {
      writeSignedPayload({ ...payload(), ...extra });
      expect(readServiceEntitlement(options).state).toBe("invalid");
    }
    const envelope = { ...signed(canonicalServiceEntitlementPayload(payload())), alg: "EdDSA" };
    writeFileSync(options.path, JSON.stringify(envelope));
    expect(readServiceEntitlement(options).state).toBe("invalid");
  });

  it.each(["", "abc", "a".repeat(86), "a".repeat(85), "a".repeat(86) + "="])("rejects invalid signature encoding %s", signature => {
    writeFileSync(options.path, JSON.stringify({ ...signed(canonicalServiceEntitlementPayload(payload())), signature }));
    expect(readServiceEntitlement(options).state).toBe("invalid");
  });

  it("limits active capabilities and never allows unknown capabilities in development", () => {
    writeGrant(payload({ capabilities: ["reasoning"] }));
    expect(() => assertServiceEntitlementCapability("reasoning", options)).not.toThrow();
    expect(() => assertServiceEntitlementCapability("connected-tools", options)).toThrow(expect.objectContaining({ status: 403 }));
    expect(() => assertServiceEntitlementCapability("computer-use", options)).toThrow(expect.objectContaining({ status: 403 }));
    expect(() => assertServiceEntitlementCapability("voice", options)).toThrow(expect.objectContaining({ status: 403 }));
    expect(() => assertServiceEntitlementCapability("unknown" as ServiceEntitlementCapability, { ...options, managed: false })).toThrow(expect.objectContaining({ status: 403 }));
  });

  it("requires an explicit voice grant independently of reasoning access", () => {
    writeGrant(payload({ capabilities: ["reasoning"] }));
    expect(() => assertServiceEntitlementCapability("voice", options)).toThrow(expect.objectContaining({ status: 403 }));
    writeGrant(payload({ capabilities: ["voice"] }));
    expect(readServiceEntitlement(options)).toMatchObject({ state: "active", capabilities: ["voice"] });
    expect(() => assertServiceEntitlementCapability("voice", options)).not.toThrow();
    expect(() => assertServiceEntitlementCapability("reasoning", options)).toThrow(expect.objectContaining({ status: 403 }));
  });

  it("leaves inactive status readable and excludes signed private references from public status/errors", () => {
    writeGrant(payload({ expiresAt: NOW }));
    const expired = readServiceEntitlement(options);
    expect(expired.state).toBe("expired");
    expect(expired.capabilities).toEqual([]);
    const output = JSON.stringify(expired);
    for (const hidden of ["license-fixture-private-reference", COMPANY, HOST, options.path, options.trustedKeysPath, publicKeyPem]) {
      expect(output).not.toContain(hidden);
    }
    writeFileSync(options.path, "bad secret fixture body");
    expect(JSON.stringify(readServiceEntitlement(options))).not.toContain("bad secret fixture body");
  });
});

describe("entitlement validity and strict schema", () => {
  it("uses inclusive notBefore and exclusive expiresAt boundaries", () => {
    writeGrant(payload({ notBefore: NOW, expiresAt: NOW + 1 }));
    expect(readServiceEntitlement({ ...options, now: NOW - 1 })).toMatchObject({ state: "not-yet-valid", capabilities: [] });
    expect(readServiceEntitlement(options).state).toBe("active");
    expect(readServiceEntitlement({ ...options, now: NOW + 1 })).toMatchObject({ state: "expired", capabilities: [] });
    expect(() => assertServiceEntitlementCapability("reasoning", { ...options, now: NOW + 1 })).toThrow(expect.objectContaining({ status: 402 }));
  });

  it.each([
    { schema: 2 }, { licenseId: "" }, { companyId: "company/name" }, { hostInstallationId: "" },
    { issuedAt: 0 }, { issuedAt: NOW + 1 }, { notBefore: NOW - 2 * DAY }, { expiresAt: NOW - DAY },
    { expiresAt: NOW + 366 * DAY }, { expiresAt: Number.MAX_SAFE_INTEGER + 1 }, { issuedAt: "yesterday" },
    { capabilities: [] }, { capabilities: ["reasoning", "reasoning"] }, { capabilities: ["arbitrary-tool"] },
  ])("rejects a signed invalid payload %j", patch => {
    writeSignedPayload({ ...payload(), ...patch });
    expect(readServiceEntitlement(options)).toMatchObject({ state: "invalid", capabilities: [], expiresAt: null });
  });

  it("rejects missing or additional payload fields", () => {
    const missing = { ...payload() } as Partial<ServiceEntitlementPayload>;
    delete missing.hostInstallationId;
    writeSignedPayload(missing);
    expect(readServiceEntitlement(options).state).toBe("invalid");
    writeSignedPayload({ ...payload(), permissions: "all" });
    expect(readServiceEntitlement(options).state).toBe("invalid");
  });

  it("rejects invalid clock input", () => {
    writeGrant();
    for (const now of [NaN, Infinity, -1, 1.5]) expect(readServiceEntitlement({ ...options, now }).state).toBe("invalid");
  });
});

describe("trusted key lifecycle and bounded local files", () => {
  it("supports explicit key rotation and observes withdrawal on the next read", () => {
    writeTrust([{ keyId: "issuer-one", publicKeyPem }, { keyId: "issuer-two", publicKeyPem: secondPublicKeyPem }]);
    writeFileSync(options.path, JSON.stringify(signed(canonicalServiceEntitlementPayload(payload()), "issuer-two", secondPrivateKey)));
    const authority = createServiceEntitlementAuthority(() => options);
    expect(authority.status().state).toBe("active");
    writeTrust();
    expect(authority.status().state).toBe("invalid");
    expect(() => authority.assertCapability("reasoning")).toThrow(expect.objectContaining({ status: 403 }));
  });

  it("rejects duplicate key IDs, non-Ed25519 keys and private keys in the trust file", () => {
    writeGrant();
    writeTrust([{ keyId: "issuer-one", publicKeyPem }, { keyId: "issuer-one", publicKeyPem: secondPublicKeyPem }]);
    expect(readServiceEntitlement(options).state).toBe("invalid");
    const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    for (const publicKeyPem of [ec.publicKey.export({ type: "spki", format: "pem" }).toString(),
      privateKey.export({ type: "pkcs8", format: "pem" }).toString()]) {
      writeTrust([{ keyId: "issuer-one", publicKeyPem }]);
      expect(readServiceEntitlement(options).state).toBe("invalid");
    }
  });

  it("rejects malformed trust schemas, excess keys and missing trust provisioning", () => {
    writeGrant();
    for (const trust of [{ schema: 2, keys: [] }, { schema: 1, keys: [] },
      { schema: 1, keys: [{ keyId: "issuer-one", publicKeyPem, alg: "ed25519" }] },
      { schema: 1, keys: Array.from({ length: 17 }, (_, index) => ({ keyId: `issuer-${index}`, publicKeyPem })) }]) {
      writeFileSync(options.trustedKeysPath, JSON.stringify(trust));
      expect(readServiceEntitlement(options).state).toBe("invalid");
    }
    rmSync(options.trustedKeysPath);
    expect(readServiceEntitlement(options).state).toBe("unconfigured");
  });

  it("bounds envelope, payload and trust files", () => {
    writeFileSync(options.path, " ".repeat(16 * 1024 + 1));
    expect(readServiceEntitlement(options).state).toBe("invalid");
    writeSignedPayload(" ".repeat(4097));
    expect(readServiceEntitlement(options).state).toBe("invalid");
    writeGrant();
    writeFileSync(options.trustedKeysPath, " ".repeat(64 * 1024 + 1));
    expect(readServiceEntitlement(options).state).toBe("invalid");
  });

  it("factory policy comes only from its trusted loader and loader failures are sanitized", () => {
    writeGrant();
    const authority = createServiceEntitlementAuthority(() => options);
    expect(Object.isFrozen(authority)).toBe(true);
    expect(authority.status().state).toBe("active");
    options = { ...options, now: NOW + 2 * DAY };
    expect(() => authority.assertCapability("reasoning")).toThrow(expect.objectContaining({ status: 402 }));
    const broken = createServiceEntitlementAuthority(() => { throw new Error("private provisioning path"); });
    expect(broken.status().state).toBe("invalid");
    expect(JSON.stringify(broken.status())).not.toContain("private provisioning path");
  });
});
