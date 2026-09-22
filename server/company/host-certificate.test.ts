import { describe, expect, it, vi } from 'vitest';
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
  it('permits expired material only for local recovery, never new pairing or network admission', async () => {
    const material = await createHostCertificate('localhost');
    const pairing = { version: 1 as const, origin: 'https://localhost:55443', certificatePem: material.cert, companyId: '11111111-1111-4111-8111-111111111111' };
    const code = encodeCompanyPairing(pairing);
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(new X509Certificate(material.cert).validTo) + 1000);
    try {
      expect(() => parseCompanyPairing(code)).toThrow();
      expect(() => validateHostCertificate(material.cert, material.key, 'localhost')).toThrow();
      expect(parseCompanyPairing(code, { allowExpired: true })).toEqual(pairing);
      expect(() => validateHostCertificate(material.cert, material.key, 'localhost', { allowExpired: true })).not.toThrow();
      expect(() => validateHostCertificate(material.cert, material.key, 'wrong.example', { allowExpired: true })).toThrow();
    } finally { now.mockRestore(); }
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
