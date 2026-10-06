// RealBud publisher signatures for customer packs (Ed25519, node:crypto only).
// The private key lives with the publisher, outside this repo, customer storage
// and Hermes storage; the app pins public keys only. See
// docs/decisions/2026-10-06-rei-source-of-truth-and-client-packs.md.
import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import type { CustomerPack } from '../shared/customer-packs.ts';

export interface PackPublisherKey { keyId: string; /** SPKI DER, base64. */ publicKey: string }
export type PackSignature = NonNullable<CustomerPack['signature']>;

/** Pinned RealBud publisher keys. Several may be listed while a key rotates;
 * remove a key to revoke it. Empty until the owner pins the first public key
 * (`node scripts/sign-pack.mjs --public --key <path>` prints the entry). */
export const PACK_PUBLISHER_KEYS: readonly PackPublisherKey[] = [
  // RealBud publisher key, generated 2026-10-06 by the owner. Private key held offline (1Password).
  { keyId: 'realbud-2026-10', publicKey: 'MCowBQYDK2VwAyEAV2xTNNnqf4GpjlAo0zBqHXqlTUOcD9d+dJbVdSNYyQQ=' },
];

export const UNSIGNED_PACK_MESSAGE = "This pack isn't signed by RealBud, so it wasn't installed.";
const refuse = (): never => { throw Object.assign(new Error(UNSIGNED_PACK_MESSAGE), { status: 400 }); };
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** Sorted-key JSON; the same value always yields the same bytes. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error('Pack content must be plain JSON.');
  return text;
}

/** The signed bytes: the canonical manifest (pack minus files and signature)
 * plus each file's path and sha256, sorted by path. */
export function packSigningBytes(pack: { files?: Record<string, string>; signature?: unknown }): Buffer {
  const { files = {}, signature: _signature, ...manifest } = pack;
  const hashes = Object.keys(files).sort().map(path => [path, sha256(files[path])]);
  return Buffer.from(canonicalJson({ purpose: 'realbud-customer-pack-signature', version: 1, manifest, files: hashes }));
}

export function signPack<T extends { files?: Record<string, string>; signature?: PackSignature }>(pack: T, privateKey: KeyObject | string, keyId: string): T & { signature: PackSignature } {
  const key = typeof privateKey === 'string' ? createPrivateKey(privateKey) : privateKey;
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('The signing key must be an Ed25519 private key.');
  const { signature: _old, ...unsigned } = pack;
  return { ...unsigned, signature: { algorithm: 'ed25519', keyId, value: sign(null, packSigningBytes(unsigned), key).toString('base64') } } as T & { signature: PackSignature };
}

export const publicKeyEntry = (keyId: string, key: KeyObject | string): PackPublisherKey =>
  ({ keyId, publicKey: (typeof key !== 'string' && key.type === 'public' ? key : createPublicKey(key)).export({ format: 'der', type: 'spki' }).toString('base64') });

/** Returns the signing key id, or refuses an unsigned, tampered or unknown-key pack. */
export function verifyPackSignature(pack: { files?: Record<string, string>; signature?: PackSignature }, keys: readonly PackPublisherKey[] = PACK_PUBLISHER_KEYS): string {
  const signature = pack.signature;
  if (!signature || signature.algorithm !== 'ed25519' || typeof signature.value !== 'string') return refuse();
  const pinned = keys.find(key => key.keyId === signature.keyId);
  if (!pinned) return refuse();
  let ok = false;
  try { ok = verify(null, packSigningBytes(pack), createPublicKey({ key: Buffer.from(pinned.publicKey, 'base64'), format: 'der', type: 'spki' }), Buffer.from(signature.value, 'base64')); }
  catch { ok = false; }
  return ok ? signature.keyId : refuse();
}
