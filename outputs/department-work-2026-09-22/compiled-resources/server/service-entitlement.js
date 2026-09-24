import { createPublicKey, verify } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { SERVICE_ENTITLEMENT_CAPABILITIES, } from "../shared/service-entitlement.js";
const MAX_ENVELOPE_BYTES = 16 * 1024;
const MAX_TRUST_BYTES = 64 * 1024;
const MAX_PAYLOAD_BYTES = 4096;
const MAX_LIFETIME_MS = 366 * 24 * 60 * 60_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const PUBLIC_PEM = /^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----(?:\r?\n)?$/;
const CAPABILITIES = new Set(SERVICE_ENTITLEMENT_CAPABILITIES);
export class ServiceEntitlementError extends Error {
    status;
    constructor(message, status) {
        super(message);
        this.name = "ServiceEntitlementError";
        this.status = status;
    }
}
function object(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exact(value, keys) {
    return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function invalid() { throw new Error("invalid service entitlement"); }
/** Allocation and reads are bounded even if a file grows between stat/read. */
function readBoundedJson(path, limit) {
    const fd = openSync(path, "r");
    try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > limit)
            invalid();
        const bytes = Buffer.alloc(limit + 1);
        let size = 0;
        while (size <= limit) {
            const count = readSync(fd, bytes, size, bytes.length - size, null);
            if (!count)
                break;
            size += count;
        }
        if (size > limit)
            invalid();
        return JSON.parse(bytes.subarray(0, size).toString("utf8"));
    }
    finally {
        closeSync(fd);
    }
}
function payloadValid(value) {
    if (!object(value) || !exact(value, ["schema", "licenseId", "companyId", "hostInstallationId", "issuedAt", "notBefore", "expiresAt", "capabilities"]) || value.schema !== 1)
        return false;
    if ([value.licenseId, value.companyId, value.hostInstallationId].some(id => typeof id !== "string" || !ID.test(id)))
        return false;
    if ([value.issuedAt, value.notBefore, value.expiresAt].some(at => typeof at !== "number" || !Number.isSafeInteger(at) || at <= 0))
        return false;
    const issuedAt = value.issuedAt, notBefore = value.notBefore, expiresAt = value.expiresAt;
    if (notBefore < issuedAt || expiresAt <= notBefore || expiresAt - issuedAt > MAX_LIFETIME_MS)
        return false;
    const capabilities = value.capabilities;
    return Array.isArray(capabilities) && capabilities.length > 0 && capabilities.length <= CAPABILITIES.size &&
        capabilities.every(capability => typeof capability === "string" && CAPABILITIES.has(capability)) && new Set(capabilities).size === capabilities.length;
}
/** Deterministic signing bytes for the separate issuer. This module neither
 * issues grants nor loads a private key. Fixed field order; capabilities sorted.
 */
export function canonicalServiceEntitlementPayload(payload) {
    if (!payloadValid(payload))
        invalid();
    return JSON.stringify({ schema: 1, licenseId: payload.licenseId, companyId: payload.companyId,
        hostInstallationId: payload.hostInstallationId, issuedAt: payload.issuedAt, notBefore: payload.notBefore,
        expiresAt: payload.expiresAt, capabilities: [...payload.capabilities].sort() });
}
function trustedKey(path, keyId) {
    const trust = readBoundedJson(path, MAX_TRUST_BYTES);
    if (!object(trust) || !exact(trust, ["schema", "keys"]) || trust.schema !== 1 ||
        !Array.isArray(trust.keys) || trust.keys.length === 0 || trust.keys.length > 16)
        invalid();
    const keys = new Map();
    for (const entry of trust.keys) {
        if (!object(entry) || !exact(entry, ["keyId", "publicKeyPem"]) || typeof entry.keyId !== "string" ||
            !ID.test(entry.keyId) || keys.has(entry.keyId) || typeof entry.publicKeyPem !== "string" ||
            entry.publicKeyPem.length > 4096 || !PUBLIC_PEM.test(entry.publicKeyPem))
            invalid();
        const key = createPublicKey(entry.publicKeyPem);
        if (key.type !== "public" || key.asymmetricKeyType !== "ed25519")
            invalid();
        keys.set(entry.keyId, key);
    }
    return keys.get(keyId) ?? invalid();
}
function status(state, options, error = null, payload) {
    return { state, managed: options.managed, required: options.required,
        capabilities: state === "unmanaged" || state === "not-required" ? [...SERVICE_ENTITLEMENT_CAPABILITIES]
            : state === "active" && payload ? [...payload.capabilities].sort() : [],
        expiresAt: payload?.expiresAt ?? null, error };
}
/** A local signed-grant check, not a billing, live-revocation or tamper-proof
 * host service. Public keys, expected company/host and policy come from trusted
 * provisioning. Off-device services must independently enforce their grants.
 */
export function readServiceEntitlement(options) {
    if (!options || typeof options.managed !== "boolean" ||
        (options.required !== undefined && typeof options.required !== "boolean")) {
        return status("invalid", { managed: true, required: true }, "Managed service policy is invalid. Contact service support.");
    }
    const policy = { managed: options.managed, required: options.managed && options.required !== false };
    if (!policy.managed)
        return status("unmanaged", policy);
    if (!policy.required)
        return status("not-required", policy);
    if (!options.companyId || !ID.test(options.companyId) || !options.hostInstallationId || !ID.test(options.hostInstallationId)) {
        return status("unconfigured", policy, "Managed service needs trusted company and host provisioning.");
    }
    try {
        const now = typeof options.now === "function" ? options.now() : options.now ?? Date.now();
        if (!Number.isSafeInteger(now) || now < 0)
            invalid();
        const envelope = readBoundedJson(options.path, MAX_ENVELOPE_BYTES);
        if (!object(envelope) || !exact(envelope, ["schema", "keyId", "payload", "signature"]) || envelope.schema !== 1 ||
            typeof envelope.keyId !== "string" || !ID.test(envelope.keyId) || typeof envelope.payload !== "string" ||
            Buffer.byteLength(envelope.payload, "utf8") > MAX_PAYLOAD_BYTES || typeof envelope.signature !== "string" ||
            !/^[A-Za-z0-9_-]{86}$/.test(envelope.signature))
            invalid();
        const signature = Buffer.from(envelope.signature, "base64url");
        if (signature.length !== 64 || signature.toString("base64url") !== envelope.signature)
            invalid();
        const key = trustedKey(options.trustedKeysPath, envelope.keyId);
        if (!verify(null, Buffer.from(envelope.payload, "utf8"), key, signature))
            invalid();
        const payload = JSON.parse(envelope.payload);
        if (!payloadValid(payload) || envelope.payload !== canonicalServiceEntitlementPayload(payload))
            invalid();
        if (payload.companyId !== options.companyId || payload.hostInstallationId !== options.hostInstallationId)
            invalid();
        if (now < payload.notBefore)
            return status("not-yet-valid", policy, "Managed service entitlement is not active yet.", payload);
        if (now >= payload.expiresAt)
            return status("expired", policy, "Managed service entitlement has expired. Contact service support.", payload);
        return status("active", policy, null, payload);
    }
    catch (error) {
        if (error.code === "ENOENT") {
            return status("unconfigured", policy, "Managed service entitlement is not configured. Contact service support.");
        }
        return status("invalid", policy, "Managed service entitlement could not be verified. Contact service support.");
    }
}
function assertStatus(capability, current) {
    if (!CAPABILITIES.has(capability))
        throw new ServiceEntitlementError("That managed service capability is not supported.", 403);
    if (["unmanaged", "not-required", "active"].includes(current.state) && current.capabilities.includes(capability))
        return;
    if (current.state === "active")
        throw new ServiceEntitlementError("This managed service capability is not included in the entitlement.", 403);
    throw new ServiceEntitlementError(current.error ?? "Managed service is unavailable.", current.state === "invalid" ? 403 : 402);
}
export function assertServiceEntitlementCapability(capability, options) {
    assertStatus(capability, readServiceEntitlement(options));
}
/** Integrations close over server provisioning once. Callers supply only the
 * operation capability, never policy flags, trusted keys or a company override.
 */
export function createServiceEntitlementAuthority(loadTrustedOptions) {
    const read = () => {
        try {
            return readServiceEntitlement(loadTrustedOptions());
        }
        catch {
            return status("invalid", { managed: true, required: true }, "Managed service policy is unavailable. Contact service support.");
        }
    };
    return Object.freeze({ status: read, assertCapability: (capability) => assertStatus(capability, read()) });
}
