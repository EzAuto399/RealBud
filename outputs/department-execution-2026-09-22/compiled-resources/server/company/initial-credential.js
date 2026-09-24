import { createRecoverySecret, derivePasswordVerifier, normalizeLoginName, normalizePassword, } from "./member-credentials.js";
import { CompanyError } from "./types.js";
export async function prepareInitialCredential(input) {
    if (input === null || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
        throw new CompanyError('invalid_input');
    }
    const keys = Object.keys(input);
    if (keys.length !== 2 || !keys.includes('loginName') || !keys.includes('password')) {
        throw new CompanyError('invalid_input');
    }
    const loginName = normalizeLoginName(input.loginName);
    const password = normalizePassword(input.password);
    const passwordVerifier = await derivePasswordVerifier(password);
    const { recoveryKey, recoveryHash } = createRecoverySecret();
    return { loginName, passwordVerifier, recoveryKey, recoveryHash };
}
