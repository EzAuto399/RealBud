import { describe, expect, it } from 'vitest';
import { passwordMatches, recoveryMatches } from './member-credentials.ts';
import { prepareInitialCredential } from './initial-credential.ts';
import { CompanyError } from './types.ts';

const password = 'correct-horse-battery';
const input = { loginName: 'Owner.One', password };

function expectInvalid(value: unknown) {
  return expect(prepareInitialCredential(value)).rejects.toSatisfy(
    (error: unknown) => error instanceof CompanyError && error.code === 'invalid_input',
  );
}

describe('prepareInitialCredential', () => {
  it('normalizes login name and returns matching verifier and recovery secret', async () => {
    const snapshot = { ...input };
    const prepared = await prepareInitialCredential(input);
    expect(input).toEqual(snapshot);
    expect(prepared.loginName).toBe('owner.one');
    expect(prepared).toEqual({
      loginName: 'owner.one',
      passwordVerifier: prepared.passwordVerifier,
      recoveryKey: prepared.recoveryKey,
      recoveryHash: prepared.recoveryHash,
    });
    expect(await passwordMatches(password, prepared.passwordVerifier)).toBe(true);
    expect(recoveryMatches(prepared.recoveryKey, prepared.recoveryHash)).toBe(true);
  });

  it('rejects malformed and extra fields without mutating input', async () => {
    const extra = { ...input, other: 1 };
    const extraSnapshot = { ...extra };
    await expectInvalid(extra);
    expect(extra).toEqual(extraSnapshot);
    await expectInvalid(null);
    await expectInvalid(new (class Credential { loginName = 'alice'; password = password; })());
    await expectInvalid(['loginName', 'password']);
    await expectInvalid({ loginName: input.loginName });
    await expectInvalid({ password });
    await expectInvalid({ loginName: 'ab', password });
    await expectInvalid({ loginName: input.loginName, password: 'too-short' });
  });
});
