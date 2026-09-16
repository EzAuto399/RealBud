import { describe, expect, it } from 'vitest';
import { X509Certificate } from 'node:crypto';
import { createHostCertificate, encodeCompanyPairing, parseCompanyPairing, validateHostCertificate } from './host-certificate.ts';

describe('company host identity', () => {
  it('creates a native certificate for the exact host and rejects a different private key', async () => {
    const [first, second] = await Promise.all([createHostCertificate('127.0.0.1'), createHostCertificate('localhost')]);
    expect(new X509Certificate(first.cert).checkIP('127.0.0.1')).toBe('127.0.0.1');
    expect(() => validateHostCertificate(first.cert, first.key, '127.0.0.1')).not.toThrow();
    expect(() => validateHostCertificate(first.cert, second.key, '127.0.0.1')).toThrow();
    expect(() => validateHostCertificate(first.cert, first.key, 'different.example')).toThrow();
  });
  it('pairs only with a matching HTTPS host without credentials, paths or extra fields', async () => {
    const material = await createHostCertificate('localhost');
    const pairing = { version: 1 as const, origin: 'https://localhost:55443', certificatePem: material.cert, companyId: '11111111-1111-4111-8111-111111111111' };
    expect(parseCompanyPairing(encodeCompanyPairing(pairing))).toEqual(pairing);
    for (const origin of ['http://localhost', 'https://user:password@localhost', 'https://localhost/api', 'https://different.example']) {
      expect(() => encodeCompanyPairing({ ...pairing, origin })).toThrow();
    }
    expect(() => parseCompanyPairing('RB1.' + Buffer.from(JSON.stringify({ ...pairing, invitationToken: 'secret' })).toString('base64url'))).toThrow();
    await expect(createHostCertificate('https://localhost/')).rejects.toThrow();
  });
});
