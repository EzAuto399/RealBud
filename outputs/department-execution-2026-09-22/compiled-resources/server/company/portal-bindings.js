import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { COMPANY_PORTAL_CHALLENGE_MS, COMPANY_PORTAL_ORIGIN, isBeginCompanyPortalBinding, isAcceptCompanyPortalBinding, isRevokeCompanyPortalBinding } from "../../shared/company-portal.js";
import { commandDigest } from "../../shared/website-commands.js";
import { assertVerifiedCompanyPortalProof } from "./portal-proof.js";
import { CompanyError } from "./types.js";
const S = 'realbud_company';
const hash = (v) => createHash('sha256').update(v).digest('hex');
const fail = (code) => { throw new CompanyError(code); };
const requestBody = (input) => { const { proofHandle, ...body } = input; return { ...body, proofHandleHash: hash(proofHandle) }; };
const columns = `b.*,m.display_name AS member_name,m.active AS member_active,o.active AS creator_active,o.role AS creator_role,c.remote_authority_incarnation AS current_authority,c.portal_issuer,c.portal_company_id`;
const joins = `JOIN ${S}.members m ON m.company_id=b.company_id AND m.id=b.member_id JOIN ${S}.members o ON o.company_id=b.company_id AND o.id=b.created_by JOIN ${S}.companies c ON c.id=b.company_id`;
/** Identity mapping only. No method grants department access or starts a worker. */
export function createPortalBindingApi({ authenticated, portalBridge }) {
    // The gate covers authenticated() through its awaited COMMIT. Network proof
    // redemption is deliberately outside this gate, so renewal never waits on HTTP.
    function certificateTransaction(session, work, lifecycle = false) {
        return portalBridge ? portalBridge.withCertificate(() => authenticated(session, work, lifecycle)) : authenticated(session, work, lifecycle);
    }
    function certificate() { const value = portalBridge?.certificateDigest(); if (!value || !commandDigest.test(value))
        return fail('recovery_required'); return value; }
    function target(row, purpose) {
        return { version: 1, purpose, companyId: row.company_id, authorityId: row.authority_id, certificateDigest: row.certificate_digest, bindingId: row.id, memberId: row.member_id, challengeHash: purpose === 'member-map' ? row.map_challenge_hash : row.confirm_challenge_hash, expiresAt: row.expires_at.toISOString() };
    }
    function current(row, cert, now) {
        return !row.revoked_at && row.member_active && row.current_authority === row.authority_id && row.certificate_digest === cert &&
            (row.confirmed_at ? row.portal_issuer === row.candidate_proof?.issuer && row.portal_company_id === row.candidate_proof?.person.companyId : row.creator_active && row.creator_role === 'owner' && row.expires_at.getTime() > now);
    }
    function view(row, cert, now) {
        const p = row.candidate_proof?.person;
        return { id: row.id, memberId: row.member_id, memberName: row.member_name, revision: String(row.revision), phase: row.revoked_at ? 'revoked' : row.confirmed_at ? 'confirmed' : p ? 'candidate' : 'pending', current: current(row, cert, now), person: p ? { subject: p.subject, identityEpoch: p.identityEpoch, email: p.email, agencyLabel: p.agencyLabel, companyId: p.companyId } : null, mapTarget: target(row, 'member-map'), confirmTarget: target(row, 'member-confirm'), createdAt: row.created_at.toISOString(), confirmedAt: row.confirmed_at?.toISOString() ?? null, revokedAt: row.revoked_at?.toISOString() ?? null };
    }
    async function now(client) { return Number((await client.query('SELECT floor(extract(epoch from clock_timestamp())*1000)::text AS ms')).rows[0].ms); }
    async function selected(client, actor, id) {
        const found = await client.query(`SELECT ${columns} FROM ${S}.portal_member_bindings b ${joins} WHERE b.company_id=$1 AND b.id=$2 FOR UPDATE OF b`, [actor.companyId, id]);
        return found.rows[0] ?? fail('not_found');
    }
    async function lockRequest(client, actor, id) { await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`department-operation:${actor.companyId}:${id}`]); }
    async function unusedOperation(client, actor, id, bindingId) {
        const used = await client.query(`SELECT 1 FROM ${S}.audit_events WHERE company_id=$1 AND id=$2 UNION ALL SELECT 1 FROM ${S}.claim_receipts WHERE company_id=$1 AND id=$2 UNION ALL SELECT 1 FROM ${S}.portal_member_bindings WHERE company_id=$1 AND (id=$2 OR map_request->>'requestId'=$2::text OR confirm_request->>'requestId'=$2::text OR revoke_request->>'requestId'=$2::text) AND id<>$3`, [actor.companyId, id, bindingId]);
        if (used.rowCount)
            fail('conflict');
    }
    function checkRole(actor, row, purpose) {
        if (purpose === 'member-map' ? actor.memberId !== row.member_id : actor.role !== 'owner' || actor.memberId !== row.created_by)
            fail('forbidden');
    }
    function active(row, cert, at) {
        if (row.revoked_at || !row.member_active || !row.creator_active || row.creator_role !== 'owner' || row.authority_id !== row.current_authority || row.certificate_digest !== cert || row.expires_at.getTime() <= at)
            fail('conflict');
    }
    async function operation(session, input, purpose) {
        if (!isAcceptCompanyPortalBinding(input))
            fail('invalid_input');
        const savedBody = JSON.parse(JSON.stringify(requestBody(input)));
        // Persist exact redemption identity/body before leaving the local authority.
        const redeem = await certificateTransaction(session, async (client, actor) => {
            await lockRequest(client, actor, input.requestId);
            const row = await selected(client, actor, input.bindingId);
            checkRole(actor, row, purpose);
            const at = await now(client);
            active(row, certificate(), at);
            const old = purpose === 'member-map' ? row.map_request : row.confirm_request;
            if (old) {
                if (!isDeepStrictEqual(old, savedBody))
                    fail('conflict');
            }
            else {
                await unusedOperation(client, actor, input.requestId, row.id);
                if (String(row.revision) !== input.expectedRevision || purpose === 'member-map' && row.candidate_proof || purpose === 'member-confirm' && (!row.candidate_proof || row.confirmed_at))
                    fail('conflict');
                if (input.requestId === row.id || row.map_request?.requestId === input.requestId || row.confirm_request?.requestId === input.requestId || row.revoke_request?.requestId === input.requestId)
                    fail('conflict');
                const freshAt = await now(client);
                active(row, certificate(), freshAt);
                await client.query(`UPDATE ${S}.portal_member_bindings SET ${purpose === 'member-map' ? 'map_request' : 'confirm_request'}=$3 WHERE company_id=$1 AND id=$2`, [actor.companyId, row.id, JSON.stringify(savedBody)]);
                await client.query(`INSERT INTO ${S}.audit_events(id,company_id,actor_member_id,kind,details) VALUES($1,$2,$3,$4,$5)`, [input.requestId, actor.companyId, actor.memberId, `portal.${purpose}.reserved`, JSON.stringify({ bindingId: row.id, requestDigest: hash(JSON.stringify(savedBody)) })]);
            }
            const completedAt = await now(client);
            active(row, certificate(), completedAt);
            return { version: 1, proofHandle: input.proofHandle, target: target(row, purpose), redemptionId: purpose === 'member-map' ? row.map_redemption_id : row.confirm_redemption_id };
        }, true);
        if (!portalBridge)
            fail('recovery_required');
        const verified = await (portalBridge ?? fail('recovery_required')).verify(redeem);
        // Proof verification and HTTP happen outside every company transaction. The
        // final transaction rechecks roles, incarnation, certificate and exact intent.
        return certificateTransaction(session, async (client, actor) => {
            await lockRequest(client, actor, input.requestId);
            const row = await selected(client, actor, input.bindingId);
            checkRole(actor, row, purpose);
            const at = await now(client), cert = certificate();
            active(row, cert, at);
            const proof = assertVerifiedCompanyPortalProof(verified, redeem, at);
            if (!isDeepStrictEqual(target(row, purpose), redeem.target) || !isDeepStrictEqual(purpose === 'member-map' ? row.map_request : row.confirm_request, savedBody))
                fail('conflict');
            if (proof.issuer !== COMPANY_PORTAL_ORIGIN || (row.portal_issuer !== null && (row.portal_issuer !== proof.issuer || row.portal_company_id !== proof.person.companyId)))
                fail('conflict');
            if (purpose === 'member-map') {
                if (row.candidate_proof) {
                    if (!isDeepStrictEqual(row.candidate_proof, proof))
                        fail('conflict');
                    return view(row, cert, at);
                }
                if (String(row.revision) !== input.expectedRevision)
                    fail('conflict');
                await client.query(`UPDATE ${S}.portal_member_bindings SET candidate_proof=$3,revision=revision+1 WHERE company_id=$1 AND id=$2`, [actor.companyId, row.id, JSON.stringify(proof)]);
            }
            else {
                if (!row.candidate_proof || !isDeepStrictEqual(row.candidate_proof.person, proof.person))
                    fail('conflict');
                if (row.confirm_proof) {
                    if (!isDeepStrictEqual(row.confirm_proof, proof))
                        fail('conflict');
                    return view(row, cert, at);
                }
                if (String(row.revision) !== input.expectedRevision)
                    fail('conflict');
                // Owner RLS can inspect every historical mapping. Never recycle a stable
                // portal person onto another local member, even after revocation or restore.
                const conflict = await client.query(`SELECT 1 FROM ${S}.portal_member_bindings WHERE company_id=$1 AND id<>$2 AND
      ((confirmed_at IS NOT NULL AND candidate_proof->'person'->>'subject'=$3 AND member_id<>$4) OR (confirmed_at IS NOT NULL AND revoked_at IS NULL AND (member_id=$4 OR candidate_proof->'person'->>'subject'=$3)))`, [actor.companyId, row.id, proof.person.subject, row.member_id]);
                if (conflict.rowCount)
                    fail('conflict');
                const freshAt = await now(client);
                active(row, certificate(), freshAt);
                assertVerifiedCompanyPortalProof(verified, redeem, freshAt);
                await client.query(`UPDATE ${S}.companies SET portal_issuer=$2,portal_company_id=$3 WHERE id=$1 AND portal_issuer IS NULL`, [actor.companyId, proof.issuer, proof.person.companyId]);
                const confirmedAt = await now(client);
                active(row, certificate(), confirmedAt);
                assertVerifiedCompanyPortalProof(verified, redeem, confirmedAt);
                await client.query(`UPDATE ${S}.portal_member_bindings SET confirm_proof=$3,confirmed_at=clock_timestamp(),revision=revision+1 WHERE company_id=$1 AND id=$2`, [actor.companyId, row.id, JSON.stringify(proof)]);
            }
            const completed = await selected(client, actor, row.id), completedAt = await now(client), completedCert = certificate();
            active(completed, completedCert, completedAt);
            assertVerifiedCompanyPortalProof(verified, redeem, completedAt);
            return view(completed, completedCert, completedAt);
        }, true);
    }
    return {
        beginPortalMemberBinding(session, input) {
            if (!isBeginCompanyPortalBinding(input))
                fail('invalid_input');
            return certificateTransaction(session, async (client, actor) => {
                if (actor.role !== 'owner')
                    fail('forbidden');
                await lockRequest(client, actor, input.requestId);
                const old = await client.query(`SELECT ${columns} FROM ${S}.portal_member_bindings b ${joins} WHERE b.company_id=$1 AND b.id=$2 FOR UPDATE OF b`, [actor.companyId, input.requestId]);
                const at = await now(client), cert = certificate();
                if (old.rows[0]) {
                    const row = old.rows[0];
                    if (row.created_by !== actor.memberId || !isDeepStrictEqual(row.begin_body, input))
                        fail('conflict');
                    return view(row, cert, at);
                }
                await unusedOperation(client, actor, input.requestId, input.requestId);
                const member = await client.query(`SELECT 1 FROM ${S}.members WHERE company_id=$1 AND id=$2 AND active FOR SHARE`, [actor.companyId, input.memberId]);
                if (!member.rowCount)
                    fail('not_found');
                if (Number((await client.query(`SELECT count(*)::int AS n FROM ${S}.portal_member_bindings WHERE company_id=$1`, [actor.companyId])).rows[0].n) >= 1000)
                    fail('conflict');
                if ((await client.query(`SELECT 1 FROM ${S}.portal_member_bindings WHERE company_id=$1 AND member_id=$2 AND revoked_at IS NULL AND (confirmed_at IS NOT NULL OR expires_at>clock_timestamp())`, [actor.companyId, input.memberId])).rowCount)
                    fail('conflict');
                const authority = (await client.query(`SELECT remote_authority_incarnation FROM ${S}.companies WHERE id=$1`, [actor.companyId])).rows[0].remote_authority_incarnation;
                if (certificate() !== cert)
                    fail('conflict');
                await client.query(`INSERT INTO ${S}.portal_member_bindings(company_id,id,member_id,created_by,begin_body,authority_id,certificate_digest,map_challenge_hash,confirm_challenge_hash,map_redemption_id,confirm_redemption_id,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [actor.companyId, input.requestId, input.memberId, actor.memberId, JSON.stringify(input), authority, cert, hash(randomBytes(32).toString('hex')), hash(randomBytes(32).toString('hex')), randomUUID(), randomUUID(), new Date(at), new Date(at + COMPANY_PORTAL_CHALLENGE_MS)]);
                await client.query(`INSERT INTO ${S}.audit_events(id,company_id,actor_member_id,kind,details) VALUES($1,$2,$3,'portal.binding.begun',$4)`, [input.requestId, actor.companyId, actor.memberId, JSON.stringify({ bindingId: input.requestId, memberId: input.memberId })]);
                const completed = await selected(client, actor, input.requestId), completedAt = await now(client);
                if (certificate() !== cert)
                    fail('conflict');
                return view(completed, cert, completedAt);
            }, true);
        },
        acceptPortalMemberBinding(session, input) { return operation(session, input, 'member-map'); },
        confirmPortalMemberBinding(session, input) { return operation(session, input, 'member-confirm'); },
        revokePortalMemberBinding(session, input) {
            if (!isRevokeCompanyPortalBinding(input))
                fail('invalid_input');
            return certificateTransaction(session, async (client, actor) => {
                await lockRequest(client, actor, input.requestId);
                const row = await selected(client, actor, input.bindingId);
                if (actor.role !== 'owner' && actor.memberId !== row.member_id)
                    fail('forbidden');
                const body = { ...input, actorMemberId: actor.memberId };
                const at = await now(client);
                if (row.revoke_request) {
                    if (!isDeepStrictEqual(row.revoke_request, body))
                        fail('conflict');
                    return view(row, portalBridge?.certificateDigest() ?? null, at);
                }
                if (row.revoked_at || String(row.revision) !== input.expectedRevision)
                    fail('conflict');
                await unusedOperation(client, actor, input.requestId, row.id);
                if (input.requestId === row.id || row.map_request?.requestId === input.requestId || row.confirm_request?.requestId === input.requestId)
                    fail('conflict');
                await client.query(`UPDATE ${S}.portal_member_bindings SET revoked_at=clock_timestamp(),revoke_request=$3,revision=revision+1 WHERE company_id=$1 AND id=$2`, [actor.companyId, row.id, JSON.stringify(body)]);
                await client.query(`INSERT INTO ${S}.audit_events(id,company_id,actor_member_id,kind,details) VALUES($1,$2,$3,'portal.binding.revoked',$4)`, [input.requestId, actor.companyId, actor.memberId, JSON.stringify({ bindingId: row.id, note: input.note })]);
                return view(await selected(client, actor, row.id), portalBridge?.certificateDigest() ?? null, at);
            }, true);
        },
        listPortalMemberBindings(session, input) {
            if (!input || Object.keys(input).sort().join(',') !== 'limit,offset' || !Number.isSafeInteger(input.offset) || input.offset < 0 || input.offset > 1000 || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)
                fail('invalid_input');
            return certificateTransaction(session, async (client, actor) => {
                const result = await client.query(`SELECT ${columns} FROM ${S}.portal_member_bindings b ${joins} WHERE b.company_id=$1 ORDER BY b.created_at,b.id LIMIT $2 OFFSET $3`, [actor.companyId, input.limit + 1, input.offset]);
                const at = await now(client), cert = portalBridge?.certificateDigest() ?? null;
                return { bindings: result.rows.slice(0, input.limit).map(row => view(row, cert, at)), offset: input.offset, hasMore: result.rows.length > input.limit, canManage: actor.role === 'owner' };
            });
        },
    };
}
