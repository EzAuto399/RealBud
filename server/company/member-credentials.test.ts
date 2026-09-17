import { describe, expect, it } from 'vitest';
import { CompanyError } from './types.ts';
import {
  createConcurrencyGate,
  createRecoverySecret,
  derivePasswordVerifier,
  normalizeLoginName,
  normalizePassword,
  passwordMatches,
  recoveryHashOf,
  recoveryMatches,
} from './member-credentials.ts';

describe('member credential helpers', () => {
  it('lowercases conservative ASCII login names and rejects the rest', () => {
    expect(normalizeLoginName('AbC_1')).toBe('abc_1');
    expect(normalizeLoginName('abc_1')).toBe('abc_1');
    expect(() => normalizeLoginName('ab')).toThrow(CompanyError);
    expect(() => normalizeLoginName('ab@cde')).toThrow(CompanyError);
    expect(() => normalizeLoginName('a'.repeat(81))).toThrow(CompanyError);
  });

  it('requires passwords between 12 and 256 characters', () => {
    expect(normalizePassword('twelve chars.')).toBe('twelve chars.');
    expect(() => normalizePassword('eleven char')).toThrow(CompanyError);
    expect(() => normalizePassword('x'.repeat(257))).toThrow(CompanyError);
  });

  it('derives a bounded scrypt verifier without persisting the password', async () => {
    const password = 'twelve chars!!';
    const verifier = await derivePasswordVerifier(password);
    expect(verifier.startsWith('scrypt$32768$8$1$')).toBe(true);
    expect(verifier.includes(password)).toBe(false);
    expect(await passwordMatches(password, verifier)).toBe(true);
    expect(await passwordMatches('twelve chars??', verifier)).toBe(false);
    expect(await passwordMatches(password, 'broken')).toBe(false);
  }, 20_000);

  it('hashes recovery keys one-way', () => {
    const secret = createRecoverySecret();
    expect(secret.recoveryKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(secret.recoveryHash).toBe(recoveryHashOf(secret.recoveryKey));
    expect(secret.recoveryHash).not.toBe(secret.recoveryKey);
    expect(recoveryMatches(secret.recoveryKey, secret.recoveryHash)).toBe(true);
    expect(recoveryMatches('other', secret.recoveryHash)).toBe(false);
  });

  it('rejects extra KDF work instead of queueing', async () => {
    const withSlot = createConcurrencyGate(4);
    const holds: Array<() => void> = [];
    const hold = () => new Promise<void>((resolve) => { holds.push(resolve); });
    const running = [withSlot(hold), withSlot(hold), withSlot(hold), withSlot(hold)];
    await expect(withSlot(async () => 'nope')).rejects.toMatchObject({ code: 'conflict' });
    holds[0]();
    await running[0];
    await expect(withSlot(async () => 'ok')).resolves.toBe('ok');
    for (const release of holds.slice(1)) release();
    await Promise.all(running);
  });
});
