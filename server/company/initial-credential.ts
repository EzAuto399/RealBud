import {
  createRecoverySecret,
  derivePasswordVerifier,
  normalizeLoginName,
  normalizePassword,
} from './member-credentials.ts';
import { CompanyError } from './types.ts';

export async function prepareInitialCredential(input: unknown) {
  if (input === null || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
    throw new CompanyError('invalid_input');
  }
  const keys = Object.keys(input);
  if (keys.length !== 2 || !keys.includes('loginName') || !keys.includes('password')) {
    throw new CompanyError('invalid_input');
  }
  const loginName = normalizeLoginName((input as { loginName: unknown }).loginName);
  const password = normalizePassword((input as { password: unknown }).password);
  const passwordVerifier = await derivePasswordVerifier(password);
  const { recoveryKey, recoveryHash } = createRecoverySecret();
  return { loginName, passwordVerifier, recoveryKey, recoveryHash };
}
