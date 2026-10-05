// A fictional pack publisher for tests. The key pair is generated in memory per
// test process and never written anywhere; only services built here trust it.
import { generateKeyPairSync } from 'node:crypto';
import { publicKeyEntry, signPack } from '../pack-signing.ts';

export const FICTIONAL_KEY_ID = 'fictional-test-publisher';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
export const FICTIONAL_PACK_KEYS = [publicKeyEntry(FICTIONAL_KEY_ID, publicKey)];
export const signFictionalPack = <T extends object>(pack: T): T => signPack(pack as T & { files?: Record<string, string> }, privateKey, FICTIONAL_KEY_ID);

type Service = { preview: (value: unknown) => unknown; install: (value: unknown, digest: string) => unknown; previewUpgrade: (value: unknown) => unknown; upgrade: (body: unknown) => unknown };
const signed = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) && !('signature' in value) ? signFictionalPack(value) : value;
/** Wraps a pack-service factory (module instances may be reset per test) so it
 * trusts the fictional key and signs fixture packs the way the publisher would. */
export function withFictionalPublisher<F extends (options: never) => Service>(create: F): F {
  return ((options: object) => {
    const service = (create as unknown as (options: object) => Service)({ trustedKeys: FICTIONAL_PACK_KEYS, ...options });
    return { ...service,
      preview: (value: unknown) => service.preview(signed(value)),
      install: (value: unknown, digest: string) => service.install(signed(value), digest),
      previewUpgrade: (value: unknown) => service.previewUpgrade(signed(value)),
      upgrade: (body: unknown) => service.upgrade(body && typeof body === 'object' && 'pack' in body ? { ...body, pack: signed(body.pack) } : body) };
  }) as unknown as F;
}
