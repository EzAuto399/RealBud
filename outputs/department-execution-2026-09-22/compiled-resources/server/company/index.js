import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createMemberCredentialApi } from "./member-credentials.js";
import { createWorkItemApi } from "./work-items.js";
import { createMembershipApi } from "./membership.js";
import { createPortalBindingApi } from "./portal-bindings.js";
import { createDepartmentExecutionApi } from "./department-execution.js";
import { createDepartmentApi } from "./departments.js";
import { insertCaseRecord } from "./case-records.js";
import { prepareInitialCredential } from "./initial-credential.js";
import { normalizeCompanyWorkflowTemplate } from "./workflow-template.js";
import { CompanyError } from "./types.js";
export { migrateCompanySchema } from "./schema.js";
export * from "./types.js";
const S = 'realbud_company';
const DAY = 86_400_000;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
function text(value, max, allowEmpty = false) {
    if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim()) || value.includes('\0')) {
        throw new CompanyError('invalid_input');
    }
    return value;
}
function uuid(value) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
        throw new CompanyError('invalid_input');
    return value;
}
function revision(value) {
    if (!/^(0|[1-9][0-9]{0,18})$/.test(value) || BigInt(value) > 9223372036854775807n)
        throw new CompanyError('invalid_input');
    return value;
}
function ttl(value, max) {
    if (!Number.isSafeInteger(value) || value < 100 || value > max)
        throw new CompanyError('invalid_input');
    return value;
}
function bearer(value) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(value))
        throw new CompanyError('unauthenticated');
    return hash(value);
}
function scope(row) {
    return { id: String(row.id), companyId: String(row.company_id), ownerMemberId: String(row.owner_member_id), kind: row.kind, name: String(row.name), revision: String(row.revision) };
}
function knowledge(row) {
    return { scopeId: String(row.scope_id), key: String(row.key), revision: String(row.revision), content: String(row.content), sourceRefs: row.source_refs, authorMemberId: String(row.author_member_id), createdAt: row.created_at.toISOString() };
}
/** Trusted service API. Never hand this pool or its credentials to a worker. */
export function createCompanyKernel(pool, options = {}) {
    let checkedRole;
    function checkRole() {
        return checkedRole ??= (async () => {
            const result = await pool.query(`SELECT r.rolsuper, r.rolbypassrls,
        pg_has_role(current_user, c.relowner, 'MEMBER') AS owns_tables
        FROM pg_roles r JOIN pg_class c ON c.oid='realbud_company.scopes'::regclass
        WHERE r.rolname=current_user`);
            const role = result.rows[0];
            if (!role || role.rolsuper || role.rolbypassrls || role.owns_tables)
                throw new CompanyError('unsafe_database_role');
        })();
    }
    async function transaction(fn) {
        await checkRole();
        const client = await pool.connect();
        let broken;
        try {
            await client.query('BEGIN');
            await client.query("SELECT set_config('realbud.company_id','',true),set_config('realbud.member_id','',true),set_config('realbud.delegation_hash','',true)");
            const result = await fn(client);
            await client.query('COMMIT');
            return result;
        }
        catch (error) {
            try {
                await client.query('ROLLBACK');
            }
            catch (rollbackError) {
                broken = rollbackError;
            }
            throw error;
        }
        finally {
            client.release(broken);
        }
    }
    async function context(client, companyId, memberId) {
        await client.query("SELECT set_config('realbud.company_id',$1,true),set_config('realbud.member_id',$2,true)", [companyId, memberId]);
    }
    async function authenticated(sessionToken, fn, lifecycle = false) {
        const tokenHash = bearer(sessionToken);
        return transaction(async (client) => {
            const candidate = await client.query(`SELECT company_id,member_id,id FROM ${S}.sessions WHERE token_hash=$1`, [tokenHash]);
            if (!candidate.rows[0])
                throw new CompanyError('unauthenticated');
            const identity = candidate.rows[0];
            // Lifecycle mutations exclude all ordinary operations before taking member
            // locks. This prevents role/leave races without lock-order upgrades.
            await client.query(`SELECT pg_advisory_xact_lock${lifecycle ? '' : '_shared'}(hashtextextended($1,0))`, [`company-lifecycle:${identity.company_id}`]);
            // Lock order is member then session, before rechecking either credential.
            // Revocation uses the corresponding exclusive lock; no row-lock upgrades.
            await client.query(`SELECT pg_advisory_xact_lock${lifecycle ? '' : '_shared'}(hashtextextended($1,0))`, [`member:${identity.company_id}:${identity.member_id}`]);
            await client.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [`session:${identity.id}`]);
            const result = await client.query(`SELECT m.company_id,m.id,m.display_name,m.role,s.id AS session_id
        FROM ${S}.sessions s JOIN ${S}.members m ON m.company_id=s.company_id AND m.id=s.member_id
        WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND m.active`, [tokenHash]);
            const row = result.rows[0];
            if (!row)
                throw new CompanyError('unauthenticated');
            const actor = { companyId: row.company_id, memberId: row.id, displayName: row.display_name, role: row.role, sessionId: row.session_id };
            await context(client, actor.companyId, actor.memberId);
            return fn(client, actor);
        });
    }
    function owner(actor) {
        if (actor.role !== 'owner')
            throw new CompanyError('forbidden');
    }
    async function newSession(client, companyId, memberId) {
        const sessionToken = token();
        const id = randomUUID();
        const result = await client.query(`INSERT INTO ${S}.sessions(id,company_id,member_id,token_hash,expires_at)
      VALUES($1,$2,$3,$4,clock_timestamp()+($5::double precision*interval '1 millisecond')) RETURNING expires_at`, [id, companyId, memberId, hash(sessionToken), DAY]);
        return { sessionToken, sessionId: id, expiresAt: result.rows[0].expires_at.toISOString() };
    }
    async function newScope(client, actor, kind, name) {
        const result = await client.query(`INSERT INTO ${S}.scopes(company_id,id,owner_member_id,kind,name)
      VALUES($1,$2,$3,$4,$5) RETURNING *`, [actor.companyId, randomUUID(), actor.memberId, kind, name]);
        return scope(result.rows[0]);
    }
    async function authorizedScope(client, actor, scopeId, permission) {
        uuid(scopeId);
        // Also locks an empty grant set. Every grant mutation and protected operation
        // takes this lock, making revocation linearizable across process/pool instances.
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`scope:${actor.companyId}:${scopeId}`]);
        const result = await client.query(`SELECT * FROM ${S}.scopes WHERE company_id=$1 AND id=$2`, [actor.companyId, scopeId]);
        if (!result.rows[0])
            throw new CompanyError('not_found');
        const found = scope(result.rows[0]);
        if (result.rows[0].purpose === 'department') {
            const allowed = await client.query(`SELECT ${S}.scope_allowed($1,$2) AS allowed`, [scopeId, permission]);
            if (!allowed.rows[0]?.allowed)
                throw new CompanyError('forbidden');
            return found;
        }
        if (found.ownerMemberId === actor.memberId || (permission === 'read' && found.kind === 'company'))
            return found;
        const grant = await client.query(`SELECT 1 FROM ${S}.scope_grants WHERE company_id=$1 AND scope_id=$2 AND member_id=$3
      AND (permission=$4 OR permission='write')`, [actor.companyId, scopeId, actor.memberId, permission]);
        if (!grant.rowCount)
            throw new CompanyError('forbidden');
        return found;
    }
    // Reviewed collaboration has its own typed mutations. Generic case operations
    // must not alias its record or attach worker claims to a text-only handoff.
    async function generalCaseScope(client, actor, scopeId) {
        const work = await client.query(`SELECT 1 FROM ${S}.knowledge_revisions
      WHERE company_id=$1 AND scope_id=$2 AND key='realbud-work-item:v1' LIMIT 1`, [actor.companyId, scopeId]);
        if (work.rowCount)
            throw new CompanyError('forbidden');
    }
    async function lockedCase(client, actor, caseId) {
        uuid(caseId);
        const found = await client.query(`SELECT scope_id FROM ${S}.cases WHERE company_id=$1 AND id=$2`, [actor.companyId, caseId]);
        if (!found.rows[0])
            throw new CompanyError('not_found');
        await authorizedScope(client, actor, found.rows[0].scope_id, 'write');
        await generalCaseScope(client, actor, found.rows[0].scope_id);
        const result = await client.query(`SELECT *,lease_expires_at>clock_timestamp() AS lease_live FROM ${S}.cases
      WHERE company_id=$1 AND id=$2 FOR UPDATE`, [actor.companyId, caseId]);
        if (!result.rows[0])
            throw new CompanyError('not_found');
        return result.rows[0];
    }
    async function receipt(client, actor, caseId, fence, kind, details) {
        const id = randomUUID();
        await client.query(`INSERT INTO ${S}.claim_receipts(company_id,id,case_id,fence,actor_member_id,kind,details)
      VALUES($1,$2,$3,$4,$5,$6,$7)`, [actor.companyId, id, caseId, fence, actor.memberId, kind, JSON.stringify(details)]);
        return id;
    }
    function currentClaim(row, actor, fence, claimToken) {
        revision(fence);
        if (row.status !== 'claimed' || row.holder_member_id !== actor.memberId || String(row.fence) !== fence || row.claim_token_hash !== bearer(claimToken) || !row.lease_live) {
            throw new CompanyError('stale_claim');
        }
    }
    const memberCredentials = createMemberCredentialApi({ transaction, authenticated, newSession, context, bearer });
    async function initialCredential(client, companyId, memberId, prepared) {
        if (!prepared)
            return {};
        try {
            await client.query(`INSERT INTO ${S}.member_credentials(company_id,member_id,login_name,password_verifier,recovery_hash,revision,failed_attempts)
        VALUES($1,$2,$3,$4,$5,1,0)`, [companyId, memberId, prepared.loginName, prepared.passwordVerifier, prepared.recoveryHash]);
        }
        catch (error) {
            if (error && typeof error === 'object' && 'code' in error && error.code === '23505')
                throw new CompanyError('conflict');
            throw error;
        }
        return { recoveryKey: prepared.recoveryKey };
    }
    return {
        ...createMembershipApi({ authenticated, transaction }),
        ...createDepartmentApi({ authenticated }),
        /** Trusted bootstrap API. HTTP setup requires an initial credential; optionality
         * preserves internal fixture and legacy enrollment compatibility. */
        async createCompany(input) {
            const name = text(input.name, 120).trim();
            const ownerName = text(input.ownerName, 120).trim();
            const prepared = input.credential === undefined ? undefined : await prepareInitialCredential(input.credential);
            return transaction(async (client) => {
                await client.query("SELECT pg_advisory_xact_lock(hashtextextended('realbud-company-bootstrap',0))");
                if (input.singleHost) {
                    const existing = await client.query(`SELECT 1 FROM ${S}.companies LIMIT 1`);
                    if (existing.rowCount)
                        throw new CompanyError('conflict', 'This host already has a company');
                }
                const companyId = randomUUID();
                const memberId = randomUUID();
                await context(client, companyId, memberId);
                await client.query(`INSERT INTO ${S}.companies(id,name) VALUES($1,$2)`, [companyId, name]);
                await client.query(`INSERT INTO ${S}.members(company_id,id,display_name,role) VALUES($1,$2,$3,'owner')`, [companyId, memberId, ownerName]);
                const companyScope = await newScope(client, { companyId, memberId }, 'company', 'Company');
                const privateScope = await newScope(client, { companyId, memberId }, 'private', 'Private');
                return { companyId, memberId, companyScope, privateScope, ...await initialCredential(client, companyId, memberId, prepared), ...await newSession(client, companyId, memberId) };
            });
        },
        /** Service-admin surface only: no caller-selected identity and no private data. */
        getBootstrapState() {
            return transaction(async (client) => {
                const result = await client.query(`SELECT id,name,created_at FROM ${S}.companies ORDER BY created_at,id`);
                return { created: result.rows.length > 0, companies: result.rows.map(row => ({ companyId: row.id, name: row.name, createdAt: row.created_at.toISOString() })) };
            });
        },
        /** Service administration is not proof of the owner's personal identity.
         * Keep recovery held until independent owner authentication is implemented.
         * In particular, do not mint a member token or revoke any existing session.
         */
        async recoverOwnerSession(_input) {
            throw new CompanyError('owner_proof_required', 'Independent owner identity proof is required before recovery');
        },
        enrollMemberCredential: memberCredentials.enrollMemberCredential,
        signInMember: memberCredentials.signInMember,
        recoverMember: memberCredentials.recoverMember,
        readWorkflowTemplate(sessionToken) {
            return authenticated(sessionToken, async (client, actor) => {
                const result = await client.query(`SELECT revision,payload,updated_at FROM ${S}.workflow_templates WHERE company_id=$1`, [actor.companyId]);
                const row = result.rows[0];
                return { revision: String(row?.revision ?? '0'), template: row ? normalizeCompanyWorkflowTemplate(row.payload) : null,
                    updatedAt: row ? row.updated_at.toISOString() : null };
            });
        },
        async publishWorkflowTemplate(sessionToken, input) {
            revision(input.expectedRevision);
            let template;
            try {
                template = normalizeCompanyWorkflowTemplate(input.template);
            }
            catch {
                throw new CompanyError('invalid_input');
            }
            return authenticated(sessionToken, async (client, actor) => {
                owner(actor);
                await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`templates:${actor.companyId}`]);
                const found = await client.query(`SELECT revision FROM ${S}.workflow_templates WHERE company_id=$1`, [actor.companyId]);
                if (String(found.rows[0]?.revision ?? '0') !== input.expectedRevision)
                    throw new CompanyError('conflict');
                const next = (BigInt(input.expectedRevision) + 1n).toString();
                const saved = await client.query(`INSERT INTO ${S}.workflow_templates(company_id,revision,payload) VALUES($1,$2,$3)
          ON CONFLICT(company_id) DO UPDATE SET revision=EXCLUDED.revision,payload=EXCLUDED.payload,updated_at=clock_timestamp()
          RETURNING updated_at`, [actor.companyId, next, JSON.stringify(template)]);
                return { revision: next, template, updatedAt: saved.rows[0].updated_at.toISOString() };
            });
        },
        authenticateSession(sessionToken) {
            return authenticated(sessionToken, async (_client, actor) => actor);
        },
        revokeSession(sessionToken) {
            const tokenHash = bearer(sessionToken);
            return transaction(async (client) => {
                const selected = await client.query(`SELECT company_id,member_id,id FROM ${S}.sessions WHERE token_hash=$1`, [tokenHash]);
                if (!selected.rows[0])
                    throw new CompanyError('unauthenticated');
                const identity = selected.rows[0];
                await client.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [`member:${identity.company_id}:${identity.member_id}`]);
                await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`session:${identity.id}`]);
                await client.query(`UPDATE ${S}.sessions SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=$1`, [identity.id]);
            });
        },
        issueInvitation(sessionToken, input) {
            const displayName = text(input.displayName, 120).trim();
            const expiresInMs = ttl(input.expiresInMs ?? DAY, 7 * DAY);
            return authenticated(sessionToken, async (client, actor) => {
                owner(actor);
                const invitationToken = token();
                const invitationId = randomUUID();
                const result = await client.query(`INSERT INTO ${S}.invitations(id,company_id,issued_by,display_name,token_hash,expires_at)
          VALUES($1,$2,$3,$4,$5,clock_timestamp()+($6::double precision*interval '1 millisecond')) RETURNING expires_at`, [invitationId, actor.companyId, actor.memberId, displayName, hash(invitationToken), expiresInMs]);
                return { invitationId, invitationToken, expiresAt: result.rows[0].expires_at.toISOString() };
            });
        },
        revokeInvitation(sessionToken, invitationId) {
            uuid(invitationId);
            return authenticated(sessionToken, async (client, actor) => {
                owner(actor);
                const result = await client.query(`UPDATE ${S}.invitations SET revoked_at=clock_timestamp()
          WHERE company_id=$1 AND id=$2 AND redeemed_at IS NULL RETURNING id`, [actor.companyId, invitationId]);
                if (!result.rowCount)
                    throw new CompanyError('not_found');
            });
        },
        /** Possession of a one-use invitation enrolls a member; it does not verify email. */
        async redeemInvitation(invitationToken, credential) {
            const tokenHash = bearer(invitationToken);
            const prepared = credential === undefined ? undefined : await prepareInitialCredential(credential);
            return transaction(async (client) => {
                const selected = await client.query(`SELECT i.* FROM ${S}.invitations i JOIN ${S}.members m
          ON m.company_id=i.company_id AND m.id=i.issued_by
          WHERE i.token_hash=$1 AND i.redeemed_at IS NULL AND i.revoked_at IS NULL
            AND i.expires_at>clock_timestamp() AND m.active AND m.role='owner' FOR UPDATE OF i`, [tokenHash]);
                const row = selected.rows[0];
                if (!row)
                    throw new CompanyError('unauthenticated');
                const memberId = randomUUID();
                await context(client, row.company_id, memberId);
                await client.query(`UPDATE ${S}.invitations SET redeemed_at=clock_timestamp() WHERE id=$1`, [row.id]);
                await client.query(`INSERT INTO ${S}.members(company_id,id,display_name,role) VALUES($1,$2,$3,'member')`, [row.company_id, memberId, row.display_name]);
                const privateScope = await newScope(client, { companyId: row.company_id, memberId }, 'private', 'Private');
                return { companyId: row.company_id, memberId, privateScope, ...await initialCredential(client, row.company_id, memberId, prepared), ...await newSession(client, row.company_id, memberId) };
            });
        },
        revokeMember(sessionToken, memberId) {
            uuid(memberId);
            return authenticated(sessionToken, async (client, actor) => {
                owner(actor);
                if (memberId === actor.memberId)
                    throw new CompanyError('forbidden');
                await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`member:${actor.companyId}:${memberId}`]);
                const result = await client.query(`UPDATE ${S}.members SET active=false WHERE company_id=$1 AND id=$2 AND role='member' RETURNING id`, [actor.companyId, memberId]);
                if (!result.rowCount)
                    throw new CompanyError('not_found');
                await client.query(`UPDATE ${S}.sessions SET revoked_at=clock_timestamp() WHERE company_id=$1 AND member_id=$2`, [actor.companyId, memberId]);
                // Revocation never frees an executing claim. Keep an explicit recovery hold.
                await client.query(`UPDATE ${S}.cases SET status='recovery_required',fence=fence+1,claim_token_hash=NULL,lease_expires_at=NULL
          WHERE company_id=$1 AND holder_member_id=$2 AND status='claimed'`, [actor.companyId, memberId]);
            });
        },
        createScope(sessionToken, input) {
            if (!['private', 'team', 'company'].includes(input.kind))
                throw new CompanyError('invalid_input');
            const name = text(input.name, 120).trim();
            return authenticated(sessionToken, (client, actor) => {
                if (input.kind === 'company')
                    owner(actor);
                return newScope(client, actor, input.kind, name);
            });
        },
        listScopes(sessionToken) {
            return authenticated(sessionToken, async (client, actor) => {
                const result = await client.query(`SELECT * FROM ${S}.scopes WHERE company_id=$1 ORDER BY name,id`, [actor.companyId]);
                return result.rows.map(scope);
            });
        },
        setScopeGrant(sessionToken, input) {
            uuid(input.scopeId);
            uuid(input.memberId);
            revision(input.expectedRevision);
            if (!Array.isArray(input.permissions) || input.permissions.some(p => p !== 'read' && p !== 'write'))
                throw new CompanyError('invalid_input');
            const permissions = [...new Set(input.permissions)];
            return authenticated(sessionToken, async (client, actor) => {
                const found = await authorizedScope(client, actor, input.scopeId, 'read');
                const department = await client.query(`SELECT 1 FROM ${S}.scopes WHERE company_id=$1 AND id=$2 AND purpose='department'`, [actor.companyId, input.scopeId]);
                if (department.rowCount)
                    throw new CompanyError('forbidden');
                if (found.ownerMemberId !== actor.memberId)
                    throw new CompanyError('forbidden');
                if (found.kind === 'private' && input.memberId !== actor.memberId)
                    throw new CompanyError('forbidden', 'Share a reviewed copy into a team scope');
                if (found.revision !== input.expectedRevision)
                    throw new CompanyError('conflict');
                const member = await client.query(`SELECT id FROM ${S}.members WHERE company_id=$1 AND id=$2 AND active FOR SHARE`, [actor.companyId, input.memberId]);
                if (!member.rowCount)
                    throw new CompanyError('not_found');
                await client.query(`DELETE FROM ${S}.scope_grants WHERE company_id=$1 AND scope_id=$2 AND member_id=$3`, [actor.companyId, input.scopeId, input.memberId]);
                for (const permission of permissions)
                    await client.query(`INSERT INTO ${S}.scope_grants(company_id,scope_id,member_id,permission) VALUES($1,$2,$3,$4)`, [actor.companyId, input.scopeId, input.memberId, permission]);
                if (input.memberId !== found.ownerMemberId && !permissions.includes('write')) {
                    // A later grant must not revive a claim from before editing access was
                    // removed. Keep uncertain work held, as with membership revocation.
                    await client.query(`UPDATE ${S}.cases SET status='recovery_required',fence=fence+1,claim_token_hash=NULL,lease_expires_at=NULL
            WHERE company_id=$1 AND scope_id=$2 AND holder_member_id=$3 AND status='claimed'`, [actor.companyId, input.scopeId, input.memberId]);
                }
                const updated = await client.query(`UPDATE ${S}.scopes SET revision=revision+1 WHERE company_id=$1 AND id=$2 RETURNING *`, [actor.companyId, input.scopeId]);
                return scope(updated.rows[0]);
            });
        },
        readKnowledge(sessionToken, input) {
            const key = text(input.key, 128);
            return authenticated(sessionToken, async (client, actor) => {
                await authorizedScope(client, actor, input.scopeId, 'read');
                const result = await client.query(`SELECT * FROM ${S}.knowledge_revisions WHERE company_id=$1 AND scope_id=$2 AND key=$3 ORDER BY revision DESC LIMIT 1`, [actor.companyId, input.scopeId, key]);
                return result.rows[0] ? knowledge(result.rows[0]) : null;
            });
        },
        replaceKnowledge(sessionToken, input) {
            const key = text(input.key, 128);
            revision(input.expectedRevision);
            const content = text(input.content, 262_144, true);
            const sourceRefs = input.sourceRefs ?? [];
            if (!Array.isArray(sourceRefs) || sourceRefs.length > 256)
                throw new CompanyError('invalid_input');
            sourceRefs.forEach(ref => text(ref, 2048));
            return authenticated(sessionToken, async (client, actor) => {
                await authorizedScope(client, actor, input.scopeId, 'write');
                if (key === 'realbud-work-item:v1')
                    throw new CompanyError('forbidden');
                const head = await client.query(`SELECT * FROM ${S}.knowledge_revisions WHERE company_id=$1 AND scope_id=$2 AND key=$3 ORDER BY revision DESC LIMIT 1`, [actor.companyId, input.scopeId, key]);
                const current = head.rows[0];
                if (String(current?.revision ?? '0') !== input.expectedRevision)
                    throw new CompanyError('conflict');
                if (current && current.content === content && JSON.stringify(current.source_refs) === JSON.stringify(sourceRefs))
                    return knowledge(current);
                const next = (BigInt(input.expectedRevision) + 1n).toString();
                const result = await client.query(`INSERT INTO ${S}.knowledge_revisions(company_id,scope_id,key,revision,content,source_refs,author_member_id)
          VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [actor.companyId, input.scopeId, key, next, content, JSON.stringify(sourceRefs), actor.memberId]);
                return knowledge(result.rows[0]);
            });
        },
        knowledgeHistory(sessionToken, input) {
            const key = text(input.key, 128);
            const limit = input.limit ?? 30;
            if (!Number.isInteger(limit) || limit < 1 || limit > 100)
                throw new CompanyError('invalid_input');
            return authenticated(sessionToken, async (client, actor) => {
                await authorizedScope(client, actor, input.scopeId, 'read');
                const result = await client.query(`SELECT * FROM ${S}.knowledge_revisions WHERE company_id=$1 AND scope_id=$2 AND key=$3 ORDER BY revision DESC LIMIT $4`, [actor.companyId, input.scopeId, key, limit]);
                return result.rows.map(knowledge);
            });
        },
        createCase(sessionToken, input) {
            const title = text(input.title, 240).trim();
            return authenticated(sessionToken, async (client, actor) => {
                await authorizedScope(client, actor, input.scopeId, 'write');
                await generalCaseScope(client, actor, input.scopeId);
                const caseId = randomUUID();
                await insertCaseRecord(client, actor, { id: caseId, scopeId: input.scopeId, title });
                return { caseId, scopeId: input.scopeId, title, status: 'open', fence: '0' };
            });
        },
        claimCase(sessionToken, input) {
            ttl(input.ttlMs, 300_000);
            return authenticated(sessionToken, async (client, actor) => {
                const row = await lockedCase(client, actor, input.caseId);
                if (row.status === 'claimed' && row.lease_live)
                    throw new CompanyError('claim_busy');
                if (row.status === 'recovery_required' || row.status === 'claimed')
                    throw new CompanyError('recovery_required');
                if (row.status !== 'open')
                    throw new CompanyError('conflict');
                if (row.assignee_member_id && row.assignee_member_id !== actor.memberId)
                    throw new CompanyError('forbidden');
                const claimToken = token();
                const result = await client.query(`UPDATE ${S}.cases SET status='claimed',fence=fence+1,claim_token_hash=$3,holder_member_id=$4,
          lease_expires_at=clock_timestamp()+($5::double precision*interval '1 millisecond') WHERE company_id=$1 AND id=$2 RETURNING fence,lease_expires_at`, [actor.companyId, input.caseId, hash(claimToken), actor.memberId, input.ttlMs]);
                const saved = result.rows[0];
                await receipt(client, actor, input.caseId, saved.fence, 'claimed', {});
                return { caseId: input.caseId, fence: String(saved.fence), claimToken, expiresAt: saved.lease_expires_at.toISOString() };
            });
        },
        renewClaim(sessionToken, input) {
            ttl(input.ttlMs, 300_000);
            return authenticated(sessionToken, async (client, actor) => {
                const row = await lockedCase(client, actor, input.caseId);
                currentClaim(row, actor, input.fence, input.claimToken);
                const result = await client.query(`UPDATE ${S}.cases SET lease_expires_at=clock_timestamp()+($5::double precision*interval '1 millisecond')
          WHERE company_id=$1 AND id=$2 AND fence=$3 AND claim_token_hash=$4 AND lease_expires_at>clock_timestamp() RETURNING lease_expires_at`, [actor.companyId, input.caseId, input.fence, hash(input.claimToken), input.ttlMs]);
                if (!result.rows[0])
                    throw new CompanyError('stale_claim');
                return { caseId: input.caseId, fence: input.fence, claimToken: input.claimToken, expiresAt: result.rows[0].lease_expires_at.toISOString() };
            });
        },
        settleClaim(sessionToken, input) {
            if (input.outcome !== 'done' && input.outcome !== 'released')
                throw new CompanyError('invalid_input');
            const note = text(input.note ?? '', 2048, true);
            return authenticated(sessionToken, async (client, actor) => {
                const row = await lockedCase(client, actor, input.caseId);
                currentClaim(row, actor, input.fence, input.claimToken);
                const result = await client.query(`UPDATE ${S}.cases SET status=$5,claim_token_hash=NULL,lease_expires_at=NULL,outcome=$6
          WHERE company_id=$1 AND id=$2 AND fence=$3 AND claim_token_hash=$4 AND lease_expires_at>clock_timestamp() RETURNING fence`, [actor.companyId, input.caseId, input.fence, hash(input.claimToken), input.outcome === 'done' ? 'done' : 'open', JSON.stringify({ kind: input.outcome, note })]);
                if (!result.rowCount)
                    throw new CompanyError('stale_claim');
                const receiptId = await receipt(client, actor, input.caseId, input.fence, input.outcome, { note });
                return { caseId: input.caseId, status: input.outcome === 'done' ? 'done' : 'open', receiptId };
            });
        },
        ...createWorkItemApi({ authenticated, authorizedScope, newScope }),
        ...createPortalBindingApi({ authenticated, portalBridge: options.portalBridge }),
        ...createDepartmentExecutionApi({ transaction, context, authenticated, portalBridge: options.portalBridge }),
    };
}
