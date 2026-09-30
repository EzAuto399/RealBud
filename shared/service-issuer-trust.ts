/** Desktop service-grant signers this build trusts for automatic delivery.
 *
 * A grant the app fetches by itself is installed only when its signing key is
 * one of these, matched by key id and by the SHA-256 of the key's SPKI DER
 * encoding. The reply never chooses its own trust anchor. Adding a signer is a
 * release: rotate by shipping the new entry before the gateway signs with it.
 * The operator handoff (`server/service-entitlement-install-cli.ts`) keeps its
 * own explicit digest from a separate issuer receipt.
 *
 * Dependency-free: shared by the server and its tests.
 */
export interface PinnedServiceIssuer { keyId: string; publicKeySha256: string }

export const PINNED_SERVICE_ISSUERS: readonly PinnedServiceIssuer[] = Object.freeze([
  // Managed gateway signer at /data/service-issuer/ed25519-20260926-a.pem.
  Object.freeze({ keyId: "realbud-20260926-a", publicKeySha256: "403ef0870cd33acff8ce3fd8da4b1a3be3e1e5b428d32aa8a4e7e15ebf51595c" }),
]);
