/** Scoped local department preparation. Never a website approval or member session. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual as same } from 'node:util';
import { canonicalWebsiteCommand } from "../../shared/website-commands.js";
import * as C from "../../shared/company-execution.js";
import { CompanyError } from "./types.js";
const S = 'realbud_company';
const digest = (v) => createHash('sha256').update(canonicalWebsiteCommand(v)).digest('hex');
const secretHash = (v) => createHash('sha256').update(v).digest('hex');
const fail = (code) => { throw new CompanyError(code); };
function privateBody(v) { const { claimSecret, grantSecret, ...body } = v; return { ...body, ...(claimSecret ? { claimSecretHash: secretHash(claimSecret) } : {}), ...(grantSecret ? { grantSecretHash: secretHash(grantSecret) } : {}) }; }
const projection = `g.*,m.display_name AS member_name,m.active AS member_active,m.role AS member_role,m.execution_epoch AS current_member_epoch,
 o.active AS owner_active,o.role AS owner_role,o.execution_epoch AS current_owner_epoch,s.name AS department_name,s.revision AS current_department_revision,s.retired_at,
 (m.role='owner' OR EXISTS(SELECT 1 FROM ${S}.scope_grants a WHERE a.company_id=g.company_id AND a.scope_id=g.department_id AND a.member_id=g.member_id AND a.permission='write')) AS write_allowed,
 c.remote_authority_incarnation AS current_authority,k.fence AS current_case_fence,k.status AS case_status,k.assignee_member_id,k.title,k.description,k.holder_member_id,k.claim_token_hash,k.lease_expires_at AS case_lease,e.case_fence AS claim_case_fence`;
const joins = `JOIN ${S}.members m ON m.company_id=g.company_id AND m.id=g.member_id
 LEFT JOIN ${S}.members o ON o.company_id=g.company_id AND o.id=g.confirmed_by JOIN ${S}.companies c ON c.id=g.company_id
 JOIN ${S}.scopes s ON s.company_id=g.company_id AND s.id=g.department_id JOIN ${S}.cases k ON k.company_id=g.company_id AND k.id=g.case_id
 LEFT JOIN ${S}.department_execution_claims e ON e.company_id=g.company_id AND e.id=g.consumed_claim_id`;
export function createDepartmentExecutionApi(env) {
    function gated(work) { if (!env.portalBridge)
        fail('recovery_required'); return env.portalBridge.withCertificate(work); }
    function certificate() { const value = env.portalBridge?.certificateDigest(); if (!value || !C.companyExecutionSecret(value))
        return fail('recovery_required'); return value; }
    const clock = async (client) => Number((await client.query('SELECT floor(extract(epoch from clock_timestamp())*1000)::text AS ms')).rows[0].ms);
    const source = (g) => ({ caseId: g.case_id, title: g.title, description: g.description });
    function eligible(g, at, cert) {
        return !g.revoked_at && g.expires_at.getTime() > at && g.member_active && g.member_epoch === g.current_member_epoch && g.department_revision === g.current_department_revision && !g.retired_at && g.write_allowed &&
            g.spec.authorityId === g.current_authority && g.spec.certificateDigest === cert && digest(source(g)) === g.spec.sourceDigest && g.assignee_member_id === g.member_id &&
            (!g.confirmed_at || g.owner_active && g.owner_role === 'owner' && g.confirmed_epoch === g.current_owner_epoch);
    }
    function current(g, at, cert) {
        return eligible(g, at, cert) &&
            (g.consumed_claim_id ? g.case_status === 'claimed' && g.current_case_fence === g.claim_case_fence && !!g.case_lease && g.case_lease.getTime() > at : g.case_status === 'open' && g.current_case_fence === g.case_fence);
    }
    function view(g, at) { return { id: g.id, revision: g.revision, phase: g.revoked_at ? 'revoked' : g.consumed_claim_id ? 'admitted' : g.confirmed_at ? 'active' : 'pending', current: !!current(g, at, env.portalBridge?.certificateDigest() ?? null), spec: g.spec, digest: digest(g.spec), source: g.source, departmentName: g.department_name, memberName: g.member_name, createdAt: g.created_at.toISOString(), expiresAt: g.expires_at.toISOString(), confirmedAt: g.confirmed_at?.toISOString() ?? null, revokedAt: g.revoked_at?.toISOString() ?? null }; }
    async function row(client, company, id) { return (await client.query(`SELECT ${projection} FROM ${S}.department_execution_grants g ${joins} WHERE g.company_id=$1 AND g.id=$2 FOR UPDATE OF g`, [company, id])).rows[0] ?? fail('not_found'); }
    async function lock(client, key) { await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]); }
    async function locks(client, actor, id, requestId) { await lock(client, `execution-grant:${actor.companyId}:${id}`); if (requestId)
        await lock(client, `department-operation:${actor.companyId}:${requestId}`); }
    async function scope(client, g) { await lock(client, `scope:${g.company_id}:${g.department_id}`); await client.query(`SELECT id FROM ${S}.cases WHERE company_id=$1 AND id=$2 FOR UPDATE`, [g.company_id, g.case_id]); }
    async function unused(client, actor, id) { if ((await client.query(`SELECT 1 FROM ${S}.audit_events WHERE id=$1 UNION ALL SELECT 1 FROM ${S}.claim_receipts WHERE company_id=$2 AND id=$1`, [id, actor.companyId])).rowCount)
        fail('conflict'); }
    async function audit(client, actor, id, kind, body) { await client.query(`INSERT INTO ${S}.audit_events(id,company_id,actor_member_id,kind,details) VALUES($1,$2,$3,$4,$5)`, [id, actor.companyId, actor.memberId, kind, JSON.stringify(body)]); }
    async function requireCurrent(client, g, confirmed = false) { const at = await clock(client); if (!current(g, at, certificate()) || confirmed && !g.confirmed_at)
        fail('stale_claim'); return at; }
    async function delegated(secret, grantId, requestId, work) {
        if (!C.companyExecutionSecret(secret))
            fail('unauthenticated');
        return gated(() => env.transaction(async (client) => {
            await client.query("SELECT set_config('realbud.delegation_hash',$1,true)", [secretHash(secret)]);
            const candidate = (await client.query(`SELECT company_id,member_id,id FROM ${S}.department_execution_grants WHERE token_hash=$1 AND id=$2`, [secretHash(secret), grantId])).rows[0];
            if (!candidate)
                fail('unauthenticated');
            await client.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [`company-lifecycle:${candidate.company_id}`]);
            await client.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [`member:${candidate.company_id}:${candidate.member_id}`]);
            const member = (await client.query(`SELECT display_name,role,active FROM ${S}.members WHERE company_id=$1 AND id=$2`, [candidate.company_id, candidate.member_id])).rows[0];
            if (!member?.active)
                fail('unauthenticated');
            // This actor is deliberately not a CompanyActor/session and cannot be passed
            // into the general authenticated API. RLS receives the actual member only.
            const actor = { companyId: candidate.company_id, memberId: candidate.member_id, displayName: member.display_name, role: member.role };
            await env.context(client, actor.companyId, actor.memberId);
            await client.query("SELECT set_config('realbud.delegation_hash','',true)");
            await locks(client, actor, grantId, requestId);
            let g = await row(client, actor.companyId, grantId);
            if (g.token_hash !== secretHash(secret))
                fail('unauthenticated');
            await scope(client, g);
            g = await row(client, actor.companyId, grantId);
            return work(client, actor, g);
        }));
    }
    async function claim(client, g, input) {
        const e = (await client.query(`SELECT * FROM ${S}.department_execution_claims WHERE company_id=$1 AND grant_id=$2 AND execution_id=$3 FOR UPDATE`, [g.company_id, g.id, input.executionId])).rows[0];
        if (!e || e.secret_hash !== secretHash(input.claimSecret) || e.case_fence !== input.fence)
            fail('stale_claim');
        return e;
    }
    async function live(client, g, e) { const at = await requireCurrent(client, g, true); if (e.settled_at || e.lease_expires_at.getTime() <= at || g.current_case_fence !== e.case_fence || g.holder_member_id !== g.member_id || g.claim_token_hash !== e.secret_hash)
        fail('stale_claim'); return at; }
    const receipt = (g, id, executionId, fence, expires, dispatch) => ({ version: 1, grantId: g.id, receiptId: id, executionId, caseId: g.case_id, fence, leaseExpiresAt: new Date(expires).toISOString(), dispatchBefore: new Date(dispatch).toISOString() });
    return {
        beginDepartmentExecution(session, input) {
            if (!C.isBeginCompanyExecution(input))
                fail('invalid_input');
            const body = privateBody(input);
            return gated(() => env.authenticated(session, async (client, actor) => {
                await locks(client, actor, input.requestId, input.requestId);
                const previous = (await client.query(`SELECT id FROM ${S}.department_execution_grants WHERE company_id=$1 AND id=$2`, [actor.companyId, input.requestId])).rows[0];
                if (previous) {
                    const g = await row(client, actor.companyId, input.requestId);
                    if (g.member_id !== actor.memberId || !same(g.begin_body, body))
                        fail('conflict');
                    return view(g, await clock(client));
                }
                await unused(client, actor, input.requestId);
                await lock(client, `scope:${actor.companyId}:${input.departmentId}`);
                const selected = (await client.query(`SELECT k.*,s.revision AS department_revision,s.retired_at,s.purpose,m.execution_epoch,c.remote_authority_incarnation,
     (m.role='owner' OR EXISTS(SELECT 1 FROM ${S}.scope_grants a WHERE a.company_id=s.company_id AND a.scope_id=s.id AND a.member_id=m.id AND a.permission='write')) AS writable
     FROM ${S}.cases k JOIN ${S}.scopes s ON s.company_id=k.company_id AND s.id=k.scope_id JOIN ${S}.members m ON m.company_id=k.company_id AND m.id=$4 JOIN ${S}.companies c ON c.id=k.company_id
     WHERE k.company_id=$1 AND k.id=$2 AND k.scope_id=$3 FOR UPDATE OF k`, [actor.companyId, input.caseId, input.departmentId, actor.memberId])).rows[0];
                if (!selected)
                    fail('not_found');
                if (selected.purpose !== 'department' || selected.retired_at || !selected.writable || selected.assignee_member_id !== actor.memberId)
                    fail('forbidden');
                if (selected.status !== 'open' || selected.fence !== input.expectedCaseFence || selected.department_revision !== input.expectedDepartmentRevision)
                    fail('conflict');
                if (Number((await client.query(`SELECT count(*)::int AS n FROM ${S}.department_execution_grants WHERE company_id=$1`, [actor.companyId])).rows[0].n) >= 1000)
                    fail('conflict');
                const src = { caseId: input.caseId, title: selected.title, description: selected.description };
                if (!C.isCompanyExecutionSource(src))
                    fail('invalid_input');
                const at = await clock(client), cert = certificate();
                const spec = { version: 1, purpose: C.COMPANY_EXECUTION_PURPOSE, companyId: actor.companyId, memberId: actor.memberId, authorityId: selected.remote_authority_incarnation, certificateDigest: cert, departmentId: input.departmentId, departmentRevision: input.expectedDepartmentRevision, caseId: input.caseId, caseFence: input.expectedCaseFence, sourceDigest: digest(src), recipe: input.recipe, executor: input.executor };
                await client.query(`INSERT INTO ${S}.department_execution_grants(company_id,id,member_id,member_epoch,department_id,department_revision,case_id,case_fence,token_hash,begin_body,spec,source,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [actor.companyId, input.requestId, actor.memberId, selected.execution_epoch, input.departmentId, input.expectedDepartmentRevision, input.caseId, input.expectedCaseFence, secretHash(input.grantSecret), JSON.stringify(body), JSON.stringify(spec), JSON.stringify(src), new Date(at), new Date(at + input.durationMs)]);
                await audit(client, actor, input.requestId, 'department.execution.begin', { grantId: input.requestId, digest: digest(spec) });
                const result = await row(client, actor.companyId, input.requestId);
                await requireCurrent(client, result);
                return view(result, await clock(client));
            }, true));
        },
        confirmDepartmentExecution(session, input) {
            if (!C.isConfirmCompanyExecution(input))
                fail('invalid_input');
            return gated(() => env.authenticated(session, async (client, actor) => {
                if (actor.role !== 'owner')
                    fail('forbidden');
                await locks(client, actor, input.grantId, input.requestId);
                let g = await row(client, actor.companyId, input.grantId);
                await scope(client, g);
                g = await row(client, actor.companyId, input.grantId);
                if (g.confirm_request) {
                    if (!same(g.confirm_request, { ...input, actorMemberId: actor.memberId }))
                        fail('conflict');
                    return view(g, await clock(client));
                }
                await unused(client, actor, input.requestId);
                await requireCurrent(client, g);
                if (g.revision !== input.expectedRevision || digest(g.spec) !== input.grantDigest || g.consumed_claim_id)
                    fail('conflict');
                const member = (await client.query(`SELECT execution_epoch FROM ${S}.members WHERE company_id=$1 AND id=$2`, [actor.companyId, actor.memberId])).rows[0];
                await requireCurrent(client, g);
                await client.query(`UPDATE ${S}.department_execution_grants SET confirmed_by=$3,confirmed_epoch=$4,confirm_request=$5,confirmed_at=clock_timestamp(),revision=revision+1 WHERE company_id=$1 AND id=$2`, [actor.companyId, g.id, actor.memberId, member.execution_epoch, JSON.stringify({ ...input, actorMemberId: actor.memberId })]);
                await audit(client, actor, input.requestId, 'department.execution.confirm', { grantId: g.id, grantDigest: input.grantDigest });
                g = await row(client, actor.companyId, g.id);
                await requireCurrent(client, g, true);
                return view(g, await clock(client));
            }, true));
        },
        revokeDepartmentExecution(session, input) {
            if (!C.isRevokeCompanyExecution(input))
                fail('invalid_input');
            return gated(() => env.authenticated(session, async (client, actor) => {
                await locks(client, actor, input.grantId, input.requestId);
                const g = await row(client, actor.companyId, input.grantId);
                if (actor.memberId !== g.member_id && actor.role !== 'owner')
                    fail('forbidden');
                await scope(client, g);
                const body = { ...input, actorMemberId: actor.memberId };
                if (g.revoke_request) {
                    if (!same(g.revoke_request, body))
                        fail('conflict');
                    return view(g, await clock(client));
                }
                if (g.revoked_at || g.revision !== input.expectedRevision)
                    fail('conflict');
                await unused(client, actor, input.requestId);
                await client.query(`UPDATE ${S}.department_execution_grants SET revoked_at=clock_timestamp(),revoke_request=$3,revision=revision+1 WHERE company_id=$1 AND id=$2`, [actor.companyId, g.id, JSON.stringify(body)]);
                await client.query(`UPDATE ${S}.cases k SET status='recovery_required',fence=fence+1,claim_token_hash=NULL,lease_expires_at=NULL WHERE company_id=$1 AND id=$2 AND status='claimed' AND EXISTS(SELECT 1 FROM ${S}.department_execution_claims e WHERE e.company_id=k.company_id AND e.grant_id=$3 AND e.case_id=k.id AND e.case_fence=k.fence)`, [actor.companyId, g.case_id, g.id]);
                await audit(client, actor, input.requestId, 'department.execution.revoke', { grantId: g.id, note: input.note });
                return view(await row(client, actor.companyId, g.id), await clock(client));
            }, true));
        },
        listDepartmentExecutions(session, input) {
            if (!input || Object.keys(input).sort().join(',') !== 'limit,offset' || !Number.isSafeInteger(input.offset) || input.offset < 0 || input.offset > 1000 || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)
                fail('invalid_input');
            return gated(() => env.authenticated(session, async (client, actor) => {
                const rows = (await client.query(`SELECT ${projection} FROM ${S}.department_execution_grants g ${joins} WHERE g.company_id=$1 ORDER BY g.created_at,g.id LIMIT $2 OFFSET $3`, [actor.companyId, input.limit + 1, input.offset])).rows;
                const at = await clock(client);
                return { grants: rows.slice(0, input.limit).map(g => view(g, at)), offset: input.offset, hasMore: rows.length > input.limit, canManage: actor.role === 'owner' };
            }));
        },
        admitDepartmentExecution(secret, input) {
            if (!C.isAdmitCompanyExecution(input))
                fail('invalid_input');
            const body = privateBody(input);
            return delegated(secret, input.grantId, input.requestId, async (client, actor, g) => {
                const previous = (await client.query(`SELECT * FROM ${S}.department_execution_claims WHERE company_id=$1 AND id=$2`, [actor.companyId, input.requestId])).rows[0];
                if (previous) {
                    if (previous.grant_id !== g.id || !same(previous.request_body, body))
                        fail('conflict');
                    await live(client, g, previous);
                    return previous.receipt;
                }
                await unused(client, actor, input.requestId);
                const at = await requireCurrent(client, g, true);
                if (g.consumed_claim_id)
                    fail('conflict');
                if ((await client.query(`SELECT 1 FROM ${S}.department_execution_claims WHERE company_id=$1 AND execution_id=$2`, [actor.companyId, input.executionId])).rowCount)
                    fail('conflict');
                const expires = Math.min(at + input.ttlMs, g.expires_at.getTime()), dispatch = Math.min(at + C.COMPANY_EXECUTION_DISPATCH_MS, expires), fence = (BigInt(g.case_fence) + BigInt(1)).toString(), result = receipt(g, input.requestId, input.executionId, fence, expires, dispatch);
                await requireCurrent(client, g, true);
                await client.query(`UPDATE ${S}.cases SET status='claimed',fence=$3,claim_token_hash=$4,holder_member_id=$5,lease_expires_at=$6 WHERE company_id=$1 AND id=$2`, [actor.companyId, g.case_id, fence, secretHash(input.claimSecret), g.member_id, new Date(expires)]);
                await client.query(`INSERT INTO ${S}.department_execution_claims(company_id,id,grant_id,member_id,case_id,case_fence,execution_id,secret_hash,request_body,receipt,lease_receipt,admitted_at,dispatch_until,lease_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$12,$13)`, [actor.companyId, input.requestId, g.id, g.member_id, g.case_id, fence, input.executionId, secretHash(input.claimSecret), JSON.stringify(body), JSON.stringify(result), new Date(at), new Date(dispatch), new Date(expires)]);
                await client.query(`UPDATE ${S}.department_execution_grants SET consumed_claim_id=$3,revision=revision+1 WHERE company_id=$1 AND id=$2`, [actor.companyId, g.id, input.requestId]);
                await audit(client, actor, input.requestId, 'department.execution.admit', { grantId: g.id, executionId: input.executionId, fence });
                const updated = await row(client, actor.companyId, g.id);
                await requireCurrent(client, updated, true);
                return result;
            });
        },
        checkDepartmentExecution(secret, input) {
            if (!C.isCheckCompanyExecution(input))
                fail('invalid_input');
            return delegated(secret, input.grantId, undefined, async (client, _actor, g) => { const e = await claim(client, g, input); await live(client, g, e); return { receipt: e.lease_receipt, source: source(g) }; });
        },
        renewDepartmentExecution(secret, input) {
            if (!C.isRenewCompanyExecution(input))
                fail('invalid_input');
            const body = privateBody(input);
            return delegated(secret, input.grantId, input.requestId, async (client, actor, g) => {
                const e = await claim(client, g, input), at = await live(client, g, e), old = (await client.query(`SELECT * FROM ${S}.department_execution_events WHERE company_id=$1 AND id=$2`, [actor.companyId, input.requestId])).rows[0];
                if (old) {
                    if (old.claim_id !== e.id || old.kind !== 'renew' || !same(old.body, body))
                        fail('conflict');
                    return old.result;
                }
                await unused(client, actor, input.requestId);
                const expires = Math.min(Math.max(e.lease_expires_at.getTime(), at + input.ttlMs), g.expires_at.getTime()), result = receipt(g, input.requestId, e.execution_id, e.case_fence, expires, e.dispatch_until.getTime());
                await live(client, g, e);
                await client.query(`UPDATE ${S}.cases SET lease_expires_at=$3 WHERE company_id=$1 AND id=$2`, [actor.companyId, g.case_id, new Date(expires)]);
                await client.query(`UPDATE ${S}.department_execution_claims SET lease_expires_at=$3,lease_receipt=$4 WHERE company_id=$1 AND id=$2`, [actor.companyId, e.id, new Date(expires), JSON.stringify(result)]);
                await client.query(`INSERT INTO ${S}.department_execution_events(company_id,id,claim_id,kind,body,result) VALUES($1,$2,$3,'renew',$4,$5)`, [actor.companyId, input.requestId, e.id, JSON.stringify(body), JSON.stringify(result)]);
                await audit(client, actor, input.requestId, 'department.execution.renew', { grantId: g.id, claimId: e.id });
                const updated = await row(client, actor.companyId, g.id);
                await live(client, updated, { ...e, lease_expires_at: new Date(expires) });
                return result;
            });
        },
        settleDepartmentExecution(secret, input) {
            if (!C.isSettleCompanyExecution(input))
                fail('invalid_input');
            const body = privateBody(input);
            return delegated(secret, input.grantId, input.requestId, async (client, actor, g) => {
                const e = await claim(client, g, input), old = (await client.query(`SELECT * FROM ${S}.department_execution_events WHERE company_id=$1 AND id=$2`, [actor.companyId, input.requestId])).rows[0];
                if (old) {
                    if (old.claim_id !== e.id || old.kind !== 'settle' || !same(old.body, body))
                        fail('conflict');
                    const at = await clock(client);
                    if (!eligible(g, at, certificate()) || g.case_status !== 'recovery_required' || g.current_case_fence !== old.result.fence)
                        fail('stale_claim');
                    return old.result;
                }
                await live(client, g, e);
                await unused(client, actor, input.requestId);
                const fence = (BigInt(e.case_fence) + BigInt(1)).toString(), result = { receiptId: input.requestId, caseId: g.case_id, fence, status: 'recovery_required', outcome: input.outcome, runId: input.runId };
                await live(client, g, e);
                await client.query(`UPDATE ${S}.cases SET status='recovery_required',fence=$3,claim_token_hash=NULL,lease_expires_at=NULL,outcome=$4 WHERE company_id=$1 AND id=$2`, [actor.companyId, g.case_id, fence, JSON.stringify({ kind: 'department.execution.result', ...result, note: input.note })]);
                await client.query(`UPDATE ${S}.department_execution_claims SET settled_at=clock_timestamp(),settlement=$3 WHERE company_id=$1 AND id=$2`, [actor.companyId, e.id, JSON.stringify(result)]);
                await client.query(`INSERT INTO ${S}.department_execution_events(company_id,id,claim_id,kind,body,result) VALUES($1,$2,$3,'settle',$4,$5)`, [actor.companyId, input.requestId, e.id, JSON.stringify(body), JSON.stringify(result)]);
                await audit(client, actor, input.requestId, 'department.execution.settle', { grantId: g.id, claimId: e.id, outcome: input.outcome });
                const at = await clock(client);
                if (!eligible(g, at, certificate()) || e.lease_expires_at.getTime() <= at)
                    fail('stale_claim');
                return result;
            });
        },
    };
}
