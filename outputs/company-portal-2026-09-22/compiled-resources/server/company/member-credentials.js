import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { CompanyError } from "./types.js";
const S = 'realbud_company';
const N = 32_768;
const R = 8;
const P = 1;
const KEYLEN = 32;
const SALTLEN = 16;
const SCRYPT_OPTS = { N, r: R, p: P, maxmem: 64 * 1024 * 1024 };
const derive = (password, salt) => new Promise((resolve, reject) => {
    scryptCallback(password, salt, KEYLEN, SCRYPT_OPTS, (error, key) => error ? reject(error) : resolve(key));
});
const DUMMY_SALT = Buffer.alloc(SALTLEN, 7);
const DUMMY_KEY = Buffer.alloc(KEYLEN, 3);
const DUMMY_VERIFIER = `scrypt$32768$8$1$${DUMMY_SALT.toString('base64url')}$${DUMMY_KEY.toString('base64url')}`;
export function createConcurrencyGate(limit) {
    let active = 0;
    return async function withSlot(work) {
        if (active >= limit)
            throw new CompanyError('conflict');
        active += 1;
        try {
            return await work();
        }
        finally {
            active -= 1;
        }
    };
}
const withKdfSlot = createConcurrencyGate(4);
const withAuthSlot = createConcurrencyGate(8);
export function normalizeLoginName(value) {
    if (typeof value !== 'string' || value.includes('\0'))
        throw new CompanyError('invalid_input');
    const loginName = value.toLowerCase();
    if (!/^[a-z0-9._-]{3,80}$/.test(loginName))
        throw new CompanyError('invalid_input');
    return loginName;
}
export function normalizePassword(value) {
    if (typeof value !== 'string' || value.length < 12 || value.length > 256 || value.includes('\0')) {
        throw new CompanyError('invalid_input');
    }
    return value;
}
function uuid(value) {
    if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
        throw new CompanyError('invalid_input');
    }
    return value;
}
function parseVerifier(verifier) {
    const parts = verifier.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt' || parts[1] !== '32768' || parts[2] !== '8' || parts[3] !== '1')
        return null;
    if (!/^[A-Za-z0-9_-]{22}$/.test(parts[4]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[5]))
        return null;
    const salt = Buffer.from(parts[4], 'base64url');
    const key = Buffer.from(parts[5], 'base64url');
    if (salt.length !== SALTLEN || key.length !== KEYLEN)
        return null;
    return { salt, key };
}
export async function derivePasswordVerifier(password) {
    return withKdfSlot(async () => {
        const salt = randomBytes(SALTLEN);
        const key = await derive(password, salt);
        return `scrypt$32768$8$1$${salt.toString('base64url')}$${key.toString('base64url')}`;
    });
}
export async function passwordMatches(password, verifier) {
    return withKdfSlot(async () => {
        const parsed = parseVerifier(verifier);
        const salt = parsed?.salt ?? DUMMY_SALT;
        const expected = parsed?.key ?? DUMMY_KEY;
        const key = await derive(password, salt);
        const comparable = key.length === expected.length ? key : Buffer.alloc(expected.length);
        const equal = timingSafeEqual(comparable, expected);
        return Boolean(parsed) && key.length === expected.length && equal;
    });
}
export function recoveryHashOf(recoveryKey) {
    return createHash('sha256').update(recoveryKey).digest('hex');
}
const DUMMY_RECOVERY_HASH = recoveryHashOf('dummy');
export function recoveryMatches(recoveryKey, recoveryHash) {
    const actual = Buffer.from(recoveryHashOf(recoveryKey));
    const expected = Buffer.from(recoveryHash);
    if (actual.length !== expected.length) {
        timingSafeEqual(actual, actual);
        return false;
    }
    return timingSafeEqual(actual, expected);
}
export function createRecoverySecret() {
    const recoveryKey = randomBytes(32).toString('base64url');
    return { recoveryKey, recoveryHash: recoveryHashOf(recoveryKey) };
}
function isUniqueViolation(error) {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === '23505');
}
async function lockMemberExclusive(client, companyId, memberId) {
    // Exclusive member lock matches revokeMember. Never take this after a shared lock in the same transaction.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`member:${companyId}:${memberId}`]);
}
async function credentialByLogin(client, companyId, loginName) {
    const found = await client.query(`SELECT c.member_id, c.password_verifier, c.recovery_hash, c.revision, c.failed_attempts, m.active,
            (c.blocked_until IS NOT NULL AND c.blocked_until > clock_timestamp()) AS blocked
     FROM ${S}.member_credentials c
     JOIN ${S}.members m ON m.company_id=c.company_id AND m.id=c.member_id
     WHERE c.company_id=$1 AND c.login_name=$2`, [companyId, loginName]);
    return found.rows[0];
}
async function recordFailure(client, companyId, memberId) {
    await client.query(`UPDATE ${S}.member_credentials SET
      failed_attempts = CASE WHEN blocked_until IS NOT NULL AND blocked_until <= clock_timestamp() THEN 1 ELSE failed_attempts + 1 END,
      blocked_until = CASE
        WHEN (CASE WHEN blocked_until IS NOT NULL AND blocked_until <= clock_timestamp() THEN 1 ELSE failed_attempts + 1 END) >= 5
        THEN clock_timestamp() + interval '5 minutes'
        ELSE NULL
      END
     WHERE company_id=$1 AND member_id=$2`, [companyId, memberId]);
}
export function createMemberCredentialApi(env) {
    const api = {
        async enrollMemberCredential(sessionToken, input) {
            const loginName = normalizeLoginName(input.loginName);
            const password = normalizePassword(input.password);
            const currentPassword = input.currentPassword === undefined ? undefined : normalizePassword(input.currentPassword);
            const tokenHash = env.bearer(sessionToken);
            const snapshot = await env.authenticated(sessionToken, async (client, actor) => {
                const found = await client.query(`SELECT password_verifier, revision, blocked_until>clock_timestamp() AS blocked FROM ${S}.member_credentials WHERE company_id=$1 AND member_id=$2`, [actor.companyId, actor.memberId]);
                return { actor, cred: found.rows[0] };
            });
            if (snapshot.cred) {
                if (currentPassword === undefined)
                    throw new CompanyError('invalid_input');
                if (snapshot.cred.blocked)
                    throw new CompanyError('unauthenticated');
                if (!await passwordMatches(currentPassword, snapshot.cred.password_verifier)) {
                    await env.transaction(async (client) => {
                        await lockMemberExclusive(client, snapshot.actor.companyId, snapshot.actor.memberId);
                        const live = await client.query(`SELECT 1 FROM ${S}.sessions s JOIN ${S}.members m ON m.company_id=s.company_id AND m.id=s.member_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND m.active`, [tokenHash]);
                        const current = await client.query(`SELECT revision, blocked_until>clock_timestamp() AS blocked FROM ${S}.member_credentials WHERE company_id=$1 AND member_id=$2`, [snapshot.actor.companyId, snapshot.actor.memberId]);
                        if (live.rowCount && current.rows[0] && !current.rows[0].blocked && String(current.rows[0].revision) === String(snapshot.cred.revision))
                            await recordFailure(client, snapshot.actor.companyId, snapshot.actor.memberId);
                    });
                    throw new CompanyError('unauthenticated');
                }
            }
            const passwordVerifier = await derivePasswordVerifier(password);
            const recovery = createRecoverySecret();
            return env.transaction(async (client) => {
                await lockMemberExclusive(client, snapshot.actor.companyId, snapshot.actor.memberId);
                const live = await client.query(`SELECT s.id FROM ${S}.sessions s JOIN ${S}.members m ON m.company_id=s.company_id AND m.id=s.member_id
           WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND m.active`, [tokenHash]);
                if (!live.rows[0] || live.rows[0].id !== snapshot.actor.sessionId)
                    throw new CompanyError('unauthenticated');
                await env.context(client, snapshot.actor.companyId, snapshot.actor.memberId);
                const found = await client.query(`SELECT password_verifier, revision, blocked_until>clock_timestamp() AS blocked FROM ${S}.member_credentials WHERE company_id=$1 AND member_id=$2`, [snapshot.actor.companyId, snapshot.actor.memberId]);
                const cred = found.rows[0];
                if (cred?.blocked)
                    throw new CompanyError('unauthenticated');
                if (Boolean(cred) !== Boolean(snapshot.cred))
                    throw new CompanyError('conflict');
                if (cred && String(cred.revision) !== String(snapshot.cred.revision))
                    throw new CompanyError('conflict');
                try {
                    if (!cred) {
                        await client.query(`INSERT INTO ${S}.member_credentials(company_id,member_id,login_name,password_verifier,recovery_hash,revision,failed_attempts)
               VALUES($1,$2,$3,$4,$5,1,0)`, [snapshot.actor.companyId, snapshot.actor.memberId, loginName, passwordVerifier, recovery.recoveryHash]);
                    }
                    else {
                        await client.query(`UPDATE ${S}.member_credentials
               SET login_name=$3, password_verifier=$4, recovery_hash=$5, revision=revision+1, failed_attempts=0, blocked_until=NULL
               WHERE company_id=$1 AND member_id=$2`, [snapshot.actor.companyId, snapshot.actor.memberId, loginName, passwordVerifier, recovery.recoveryHash]);
                    }
                }
                catch (error) {
                    if (isUniqueViolation(error))
                        throw new CompanyError('conflict');
                    throw error;
                }
                await client.query(`UPDATE ${S}.sessions SET revoked_at=clock_timestamp()
           WHERE company_id=$1 AND member_id=$2 AND id<>$3 AND revoked_at IS NULL`, [snapshot.actor.companyId, snapshot.actor.memberId, snapshot.actor.sessionId]);
                return { loginName, recoveryKey: recovery.recoveryKey };
            });
        },
        async signInMember(input) {
            const companyId = uuid(input.companyId);
            const loginName = normalizeLoginName(input.loginName);
            const password = normalizePassword(input.password);
            const preview = await env.transaction((client) => credentialByLogin(client, companyId, loginName));
            const matches = await passwordMatches(password, preview?.password_verifier ?? DUMMY_VERIFIER);
            if (!preview)
                throw new CompanyError('unauthenticated');
            const outcome = await env.transaction(async (client) => {
                await lockMemberExclusive(client, companyId, preview.member_id);
                const row = await credentialByLogin(client, companyId, loginName);
                if (!row || row.member_id !== preview.member_id || !row.active || String(row.revision) !== String(preview.revision) || row.blocked) {
                    return { ok: false };
                }
                if (!matches || row.password_verifier !== preview.password_verifier) {
                    await recordFailure(client, companyId, row.member_id);
                    return { ok: false };
                }
                await client.query(`UPDATE ${S}.member_credentials SET failed_attempts=0, blocked_until=NULL WHERE company_id=$1 AND member_id=$2`, [companyId, row.member_id]);
                await env.context(client, companyId, row.member_id);
                return { ok: true, session: await env.newSession(client, companyId, row.member_id) };
            });
            if (!outcome.ok)
                throw new CompanyError('unauthenticated');
            return outcome.session;
        },
        async recoverMember(input) {
            const companyId = uuid(input.companyId);
            const loginName = normalizeLoginName(input.loginName);
            const newPassword = normalizePassword(input.newPassword);
            if (typeof input.recoveryKey !== 'string' || input.recoveryKey.includes('\0') || input.recoveryKey.length > 256) {
                throw new CompanyError('invalid_input');
            }
            const preview = await env.transaction((client) => credentialByLogin(client, companyId, loginName));
            const matched = recoveryMatches(input.recoveryKey, preview?.recovery_hash ?? DUMMY_RECOVERY_HASH);
            if (!preview)
                throw new CompanyError('unauthenticated');
            const passwordVerifier = matched ? await derivePasswordVerifier(newPassword) : undefined;
            const rotated = matched ? createRecoverySecret() : undefined;
            const outcome = await env.transaction(async (client) => {
                await lockMemberExclusive(client, companyId, preview.member_id);
                const row = await credentialByLogin(client, companyId, loginName);
                if (!row || row.member_id !== preview.member_id || !row.active || row.blocked)
                    return { ok: false };
                if (String(row.revision) !== String(preview.revision) || row.recovery_hash !== preview.recovery_hash)
                    return { ok: false };
                if (!matched || !passwordVerifier || !rotated) {
                    await recordFailure(client, companyId, row.member_id);
                    return { ok: false };
                }
                await client.query(`UPDATE ${S}.member_credentials
           SET password_verifier=$3, recovery_hash=$4, revision=revision+1, failed_attempts=0, blocked_until=NULL
           WHERE company_id=$1 AND member_id=$2`, [companyId, row.member_id, passwordVerifier, rotated.recoveryHash]);
                await client.query(`UPDATE ${S}.sessions SET revoked_at=clock_timestamp() WHERE company_id=$1 AND member_id=$2 AND revoked_at IS NULL`, [companyId, row.member_id]);
                await env.context(client, companyId, row.member_id);
                return { ok: true, session: await env.newSession(client, companyId, row.member_id), recoveryKey: rotated.recoveryKey };
            });
            if (!outcome.ok)
                throw new CompanyError('unauthenticated');
            return { ...outcome.session, recoveryKey: outcome.recoveryKey };
        },
    };
    return {
        enrollMemberCredential: (...args) => withAuthSlot(() => api.enrollMemberCredential(...args)),
        signInMember: (...args) => withAuthSlot(() => api.signInMember(...args)),
        recoverMember: (...args) => withAuthSlot(() => api.recoverMember(...args)),
    };
}
