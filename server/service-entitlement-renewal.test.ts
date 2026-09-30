import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalServiceEntitlementPayload, readServiceEntitlement } from "./service-entitlement.ts";
import { installReceivedServiceBundle } from "./service-entitlement-install.ts";
import { createServiceGrantRenewal, SERVICE_GRANT_COPY, SERVICE_GRANT_RETRY_MS, SERVICE_GRANT_SETTLED_RETRY_MS } from "./service-entitlement-renewal.ts";
import { PINNED_SERVICE_ISSUERS } from "../shared/service-issuer-trust.ts";
import { parseServiceGrantDelivery, SERVICE_GRANT_REQUEST } from "../shared/office-link.ts";

const NOW = Date.parse("2026-09-30T00:00:00Z");
const DAY = 86_400_000;
const COMPANY = "fictional-office", HOST = "fictional-host";
const CREDENTIAL = `rbc_${"c".repeat(64)}`;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function signer(keyId = "fictional-issuer") {
  const keys = generateKeyPairSync("ed25519");
  const publicKeySha256 = createHash("sha256").update(keys.publicKey.export({ type: "spki", format: "der" })).digest("hex");
  return { keyId, privateKey: keys.privateKey as KeyObject, publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString(), publicKeySha256 };
}
type Signer = ReturnType<typeof signer>;
const pins = (...signers: Signer[]) => signers.map(s => ({ keyId: s.keyId, publicKeySha256: s.publicKeySha256 }));
function delivery(s: Signer, patch: { expiresAt?: number; companyId?: string; hostInstallationId?: string; issuedAt?: number } = {}) {
  const issuedAt = patch.issuedAt ?? NOW;
  const payload = canonicalServiceEntitlementPayload({ schema: 1, licenseId: "fictional-license", companyId: patch.companyId ?? COMPANY,
    hostInstallationId: patch.hostInstallationId ?? HOST, issuedAt, notBefore: issuedAt, expiresAt: patch.expiresAt ?? NOW + 200 * DAY,
    capabilities: ["computer-use", "connected-tools", "reasoning", "voice"] });
  return { version: 1, purpose: "desktop-service-entitlement", companyId: COMPANY, hostInstallationId: HOST, publicKeySha256: s.publicKeySha256,
    bundle: { schema: 1, entitlement: { schema: 1, keyId: s.keyId, payload, signature: sign(null, Buffer.from(payload), s.privateKey).toString("base64url") },
      trust: { schema: 1, keys: [{ keyId: s.keyId, publicKeyPem: s.publicKeyPem }] } } };
}
function dataDir() {
  const dir = mkdtempSync(join(tmpdir(), "realbud-grant-renewal-")); roots.push(dir);
  writeFileSync(join(dir, "service-installation.json"), JSON.stringify({ schema: 1, companyId: COMPANY, hostInstallationId: HOST }), { mode: 0o600 });
  return dir;
}
const localGrant = (dir: string, now = NOW) => readServiceEntitlement({ managed: true, path: join(dir, "service-entitlement.json"),
  trustedKeysPath: join(dir, "service-trust-keys.json"), companyId: COMPANY, hostInstallationId: HOST, now });

describe("the desktop grant reply contract", () => {
  it("accepts exactly the gateway's reply for this computer and nothing else", () => {
    const s = signer();
    expect(parseServiceGrantDelivery(delivery(s), { companyId: COMPANY, hostInstallationId: HOST }).publicKeySha256).toBe(s.publicKeySha256);
    expect(() => parseServiceGrantDelivery({ ...delivery(s), extra: true }, { companyId: COMPANY, hostInstallationId: HOST })).toThrow(/cannot accept/);
    expect(() => parseServiceGrantDelivery({ ...delivery(s), version: 2 }, { companyId: COMPANY, hostInstallationId: HOST })).toThrow(/cannot accept/);
    expect(() => parseServiceGrantDelivery(delivery(s), { companyId: "another-office", hostInstallationId: HOST })).toThrow(/different computer/);
    const tampered = delivery(s); (tampered.bundle.trust.keys[0] as Record<string, unknown>).keyId = "another-issuer";
    expect(() => parseServiceGrantDelivery(tampered, { companyId: COMPANY, hostInstallationId: HOST })).toThrow(/cannot accept/);
  });
});

describe("installing a received grant", () => {
  it("pins the stated digest, binds this computer and never downgrades a longer grant", async () => {
    const dir = dataDir(), s = signer();
    const first = delivery(s, { expiresAt: NOW + 200 * DAY });
    await expect(installReceivedServiceBundle({ dataDirectory: dir, bundle: first.bundle, expectedPublicKeySha256: "0".repeat(64), now: NOW }, pins(s))).rejects.toThrow();
    expect(localGrant(dir).state).toBe("unconfigured");
    const foreign = delivery(s, { hostInstallationId: "another-host" });
    await expect(installReceivedServiceBundle({ dataDirectory: dir, bundle: foreign.bundle, expectedPublicKeySha256: s.publicKeySha256, now: NOW }, pins(s))).rejects.toThrow();
    expect(localGrant(dir).state).toBe("unconfigured");
    await expect(installReceivedServiceBundle({ dataDirectory: dir, bundle: first.bundle, expectedPublicKeySha256: s.publicKeySha256, now: NOW }, pins(s)))
      .resolves.toMatchObject({ kept: false, expiresAt: NOW + 200 * DAY });
    const shorter = delivery(s, { expiresAt: NOW + 100 * DAY, issuedAt: NOW + 1 });
    await expect(installReceivedServiceBundle({ dataDirectory: dir, bundle: shorter.bundle, expectedPublicKeySha256: s.publicKeySha256, now: NOW + 2 }, pins(s)))
      .resolves.toMatchObject({ kept: true, expiresAt: NOW + 200 * DAY });
    expect(localGrant(dir).expiresAt).toBe(NOW + 200 * DAY);
    const longer = delivery(s, { expiresAt: NOW + 300 * DAY, issuedAt: NOW + 3 });
    await expect(installReceivedServiceBundle({ dataDirectory: dir, bundle: longer.bundle, expectedPublicKeySha256: s.publicKeySha256, now: NOW + 4 }, pins(s)))
      .resolves.toMatchObject({ kept: false, expiresAt: NOW + 300 * DAY });
    expect(readFileSync(join(dir, "service-entitlement.json"), "utf8")).not.toContain("PRIVATE KEY");
  });
});

describe("the pinned signer is the only trust anchor", () => {
  it("ships the production signer and nothing else", () => {
    expect(PINNED_SERVICE_ISSUERS).toEqual([{ keyId: "realbud-20260926-a", publicKeySha256: "403ef0870cd33acff8ce3fd8da4b1a3be3e1e5b428d32aa8a4e7e15ebf51595c" }]);
  });

  it("refuses a bundle signed by an unpinned key, even with a matching stated digest, and leaves the trust file as it was", async () => {
    const dir = dataDir(), pinned = signer("fictional-pinned"), stranger = signer("fictional-stranger");
    const good = delivery(pinned);
    await installReceivedServiceBundle({ dataDirectory: dir, bundle: good.bundle, expectedPublicKeySha256: pinned.publicKeySha256, now: NOW }, pins(pinned));
    const trust = readFileSync(join(dir, "service-trust-keys.json"), "utf8"), grant = readFileSync(join(dir, "service-entitlement.json"), "utf8");
    const forged = delivery(stranger, { expiresAt: NOW + 300 * DAY });
    await expect(installReceivedServiceBundle({ dataDirectory: dir, bundle: forged.bundle, expectedPublicKeySha256: stranger.publicKeySha256, now: NOW }, pins(pinned))).rejects.toThrow();
    // A pinned key id with another key's bytes is refused too.
    const impostor = signer("fictional-pinned");
    await expect(installReceivedServiceBundle({ dataDirectory: dir, bundle: delivery(impostor).bundle, expectedPublicKeySha256: impostor.publicKeySha256, now: NOW }, pins(pinned))).rejects.toThrow();
    // A reply digest that is not the bundle key's is refused.
    await expect(installReceivedServiceBundle({ dataDirectory: dir, bundle: good.bundle, expectedPublicKeySha256: stranger.publicKeySha256, now: NOW }, pins(pinned, stranger))).rejects.toThrow();
    expect(readFileSync(join(dir, "service-trust-keys.json"), "utf8")).toBe(trust);
    expect(readFileSync(join(dir, "service-entitlement.json"), "utf8")).toBe(grant);
  });

  it("refuses an unpinned signer on a fresh computer and writes nothing", async () => {
    const dir = dataDir(), stranger = signer("fictional-stranger");
    await expect(installReceivedServiceBundle({ dataDirectory: dir, bundle: delivery(stranger).bundle, expectedPublicKeySha256: stranger.publicKeySha256, now: NOW }))
      .rejects.toThrow();
    expect(() => readFileSync(join(dir, "service-trust-keys.json"))).toThrow();
    expect(localGrant(dir).state).toBe("unconfigured");
  });
});

describe("automatic grant renewal", () => {
  function harness(reply: () => Response | Promise<Response>, options: { active?: boolean; pinned?: Signer[] } = {}) {
    const dir = dataDir();
    let time = NOW, active = options.active ?? true;
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const onInstalled = vi.fn();
    const renewal = createServiceGrantRenewal({
      directory: dir, active: async () => active, now: () => time, onInstalled,
      connector: () => ({ endpoint: "https://gateway.fictional.invalid", credential: CREDENTIAL }),
      binding: () => ({ companyId: COMPANY, hostInstallationId: HOST }),
      entitlement: () => localGrant(dir, time),
      fetch: (async (url: string, init: RequestInit) => { seen.push({ url, init }); return reply(); }) as unknown as typeof fetch,
      pinnedIssuers: pins(...(options.pinned ?? [])),
    });
    return { dir, renewal, seen, onInstalled, advance: (ms: number) => { time += ms; }, setActive: (value: boolean) => { active = value; } };
  }

  it("fetches with this computer's own credential, installs, re-runs readiness, then stays quiet while the grant is current", async () => {
    const s = signer();
    const h = harness(() => Response.json(delivery(s)), { pinned: [s] });
    await expect(h.renewal.ensure({ force: true })).resolves.toBe(true);
    expect(h.seen[0]!.url).toBe("https://gateway.fictional.invalid/v1/installations/service-entitlement");
    expect((h.seen[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${CREDENTIAL}`);
    expect(JSON.parse(String(h.seen[0]!.init.body))).toEqual(SERVICE_GRANT_REQUEST);
    expect(h.seen[0]!.init.redirect).toBe("error");
    expect(localGrant(h.dir).state).toBe("active");
    expect(h.onInstalled).toHaveBeenCalledTimes(1);
    expect(h.renewal.status()).toMatchObject({ state: "ready", detail: SERVICE_GRANT_COPY.installed });
    await h.renewal.ensure();
    expect(h.seen).toHaveLength(1);
    // Within 30 days of expiry it asks again.
    h.advance(175 * DAY);
    await h.renewal.ensure();
    expect(h.seen).toHaveLength(2);
  });

  it("holds with product copy on refusal, outage or a reply it cannot verify, and backs off", async () => {
    const s = signer();
    let reply: () => Response = () => Response.json({ error: "service_unavailable" }, { status: 403 });
    const h = harness(() => reply(), { pinned: [s] });
    await expect(h.renewal.ensure({ force: true })).resolves.toBe(false);
    expect(h.renewal.status()).toMatchObject({ state: "held", code: "held_refused", detail: SERVICE_GRANT_COPY.held_refused });
    expect(JSON.stringify(h.renewal.status())).not.toContain("service_unavailable");
    await h.renewal.ensure();
    expect(h.seen).toHaveLength(1);
    reply = () => Response.json({ ...delivery(s), publicKeySha256: "0".repeat(64) });
    await h.renewal.ensure({ force: true });
    expect(h.renewal.status()).toMatchObject({ state: "held", code: "held_invalid" });
    expect(localGrant(h.dir).state).toBe("unconfigured");
    reply = () => { throw new TypeError("fictional network down"); };
    await h.renewal.ensure({ force: true });
    expect(h.renewal.status()).toMatchObject({ state: "held", code: "held_unavailable" });
    h.advance(SERVICE_GRANT_RETRY_MS + 1);
    reply = () => Response.json(delivery(s, { issuedAt: NOW + SERVICE_GRANT_RETRY_MS + 1 }));
    await expect(h.renewal.ensure()).resolves.toBe(true);
    expect(h.onInstalled).toHaveBeenCalledTimes(1);
  });

  it("backs off for hours when the gateway has nothing newer, instead of asking every report", async () => {
    const s = signer();
    // The office's own service ends in 20 days: never 30 days clear.
    const h = harness(() => Response.json(delivery(s, { expiresAt: NOW + 20 * DAY })), { pinned: [s] });
    await expect(h.renewal.ensure({ force: true })).resolves.toBe(true);
    for (let i = 0; i < 10; i++) { h.advance(5 * 60_000); await h.renewal.ensure(); }
    expect(h.seen).toHaveLength(1);
    h.advance(SERVICE_GRANT_SETTLED_RETRY_MS);
    await expect(h.renewal.ensure()).resolves.toBe(false);
    expect(h.seen).toHaveLength(2);
    expect(h.renewal.status()).toMatchObject({ state: "ready", code: "current" });
  });

  it("does nothing without an active office link", async () => {
    const h = harness(() => Response.json({}), { active: false });
    await expect(h.renewal.ensure({ force: true })).resolves.toBe(false);
    expect(h.seen).toHaveLength(0);
  });
});
