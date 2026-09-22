import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { insertCaseRecord } from "./case-records.js";
import { CompanyError } from "./types.js";
const S = 'realbud_company';
const uuid = (value) => {
    if (typeof value !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value))
        throw new CompanyError('invalid_input');
    return value.toLowerCase();
};
function page(value, size) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 100_000 || value % size)
        throw new CompanyError('invalid_input');
}
function owner(actor) { if (actor.role !== 'owner')
    throw new CompanyError('forbidden'); }
function revision(value) {
    if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value) || BigInt(value) > 9223372036854775807n)
        throw new CompanyError('invalid_input');
}
function boundedText(value, max, empty = false) {
    if (typeof value !== 'string' || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) || (!empty && !value.trim()))
        throw new CompanyError('invalid_input');
    return value.trim();
}
function writable(found) {
    if (found.access !== 'write' || found.retiredAt)
        throw new CompanyError('forbidden');
}
function department(row) {
    return { id: String(row.id), name: String(row.name), revision: String(row.revision), access: row.access,
        retiredAt: row.retired_at instanceof Date ? row.retired_at.toISOString() : null, retiredBy: row.retired_by,
        retirementNote: String(row.retirement_note), unresolvedCases: Number(row.unresolved_cases) };
}
async function audit(client, actor, kind, details) {
    await client.query(`INSERT INTO ${S}.audit_events(id,company_id,actor_member_id,kind,details) VALUES($1,$2,$3,$4,$5)`, [randomUUID(), actor.companyId, actor.memberId, kind, JSON.stringify(details)]);
}
/** Departments share selected records, never an instance's private Bud or accounts. */
export function createDepartmentApi({ authenticated }) {
    // List only safe record fields. Claim tokens/hashes and arbitrary outcome
    // payloads are never a department read response.
    const caseColumns = `c.id,c.title,c.description,c.status,c.fence,c.created_at,c.lease_expires_at,
    am.id AS assignee_id,am.display_name AS assignee_name,am.active AS assignee_active,
    COALESCE(am.active AND (am.role='owner' OR EXISTS(SELECT 1 FROM ${S}.scope_grants ag WHERE ag.company_id=c.company_id AND ag.scope_id=c.scope_id AND ag.member_id=am.id AND ag.permission='write')),false) AS assignee_write,
    cr.id AS closure_id,cr.details AS closure_details,cr.created_at AS closed_at,cm.display_name AS closed_by,
    (c.status='recovery_required' OR (c.status='claimed' AND c.lease_expires_at<=clock_timestamp())) AS needs_review,
    m.id AS holder_id,m.display_name AS holder_name,m.active AS holder_active,
    r.id AS receipt_id,r.details AS recovery_details,r.created_at AS reviewed_at,reviewer.display_name AS reviewed_by`;
    const caseJoins = `LEFT JOIN ${S}.members am ON am.company_id=c.company_id AND am.id=c.assignee_member_id
    LEFT JOIN LATERAL (SELECT id,details,created_at,actor_member_id FROM ${S}.claim_receipts WHERE company_id=c.company_id AND case_id=c.id AND kind='department.closed' ORDER BY fence DESC LIMIT 1) cr ON true
    LEFT JOIN ${S}.members cm ON cm.company_id=c.company_id AND cm.id=cr.actor_member_id
    LEFT JOIN ${S}.members m ON m.company_id=c.company_id AND m.id=c.holder_member_id
    LEFT JOIN LATERAL (SELECT id,details,created_at,actor_member_id FROM ${S}.claim_receipts
      WHERE company_id=c.company_id AND case_id=c.id AND kind='department.recovered' ORDER BY fence DESC LIMIT 1) r ON true
    LEFT JOIN ${S}.members reviewer ON reviewer.company_id=c.company_id AND reviewer.id=r.actor_member_id`;
    function presentCase(row, actor, found) {
        const editable = row.status === 'open' && found.access === 'write' && !found.retiredAt;
        return { id: row.id, title: row.title, description: row.description, status: row.status, fence: String(row.fence),
            assignee: row.assignee_id ? { id: row.assignee_id, displayName: row.assignee_name, active: row.assignee_active, canWrite: row.assignee_write && !found.retiredAt } : null,
            needsAssignment: row.status === 'open' && (!row.assignee_id || !row.assignee_write),
            canAssign: editable, canClose: editable && (actor.role === 'owner' || row.assignee_id === actor.memberId),
            lastClosure: row.closure_id ? { receiptId: row.closure_id, resolution: row.closure_details.resolution, note: row.closure_details.note, recordedBy: row.closed_by, recordedAt: row.closed_at.toISOString() } : null,
            holder: row.holder_id ? { id: row.holder_id, displayName: row.holder_name, active: row.holder_active } : null,
            leaseExpiresAt: row.lease_expires_at?.toISOString() ?? null, createdAt: row.created_at.toISOString(), needsReview: row.needs_review,
            lastRecovery: row.receipt_id ? { receiptId: row.receipt_id, resolution: row.recovery_details.resolution, note: row.recovery_details.note, reviewedBy: row.reviewed_by, reviewedAt: row.reviewed_at.toISOString() } : null };
    }
    async function scopeLock(client, actor, id) {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`scope:${actor.companyId}:${id}`]);
    }
    async function caseResult(client, actor, id, caseId) {
        const result = await client.query(`SELECT ${caseColumns} FROM ${S}.cases c ${caseJoins} WHERE c.company_id=$1 AND c.scope_id=$2 AND c.id=$3`, [actor.companyId, id, caseId]);
        if (!result.rows[0])
            throw new CompanyError('not_found');
        return presentCase(result.rows[0], actor, await selected(client, actor, id));
    }
    async function selected(client, actor, id) {
        const result = await client.query(`SELECT s.*,(SELECT count(*) FROM ${S}.cases c WHERE c.company_id=s.company_id AND c.scope_id=s.id AND c.status IN ('open','claimed','recovery_required')) AS unresolved_cases,CASE WHEN $3='owner' OR EXISTS(SELECT 1 FROM ${S}.scope_grants g WHERE g.company_id=s.company_id AND g.scope_id=s.id AND g.member_id=$4 AND g.permission='write') THEN 'write' ELSE 'read' END AS access
      FROM ${S}.scopes s WHERE s.company_id=$1 AND s.id=$2 AND s.purpose='department'`, [actor.companyId, id, actor.role, actor.memberId]);
        if (!result.rows[0])
            throw new CompanyError('not_found');
        return department(result.rows[0]);
    }
    async function requestLock(client, actor, id) {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`department-operation:${actor.companyId}:${id}`]);
    }
    async function assigneeAllowed(client, actor, id, memberId) {
        if (memberId === null)
            return;
        const result = await client.query(`SELECT 1 FROM ${S}.members m WHERE m.company_id=$1 AND m.id=$3 AND m.active
      AND (m.role='owner' OR EXISTS(SELECT 1 FROM ${S}.scope_grants g WHERE g.company_id=m.company_id AND g.scope_id=$2 AND g.member_id=m.id AND g.permission='write')) FOR SHARE`, [actor.companyId, id, memberId]);
        if (!result.rowCount)
            throw new CompanyError('forbidden');
    }
    async function priorReceipt(client, actor, requestId, kind, details) {
        // A request UUID names one operation, not a mutable command. Replays recheck
        // current membership/scope before reading their immutable original binding.
        const rows = await client.query(`SELECT actor_member_id,kind,details FROM ${S}.claim_receipts WHERE company_id=$1 AND id=$2
      UNION ALL SELECT actor_member_id,kind,details FROM ${S}.audit_events WHERE company_id=$1 AND id=$2`, [actor.companyId, requestId]);
        if (!rows.rowCount)
            return false;
        if (rows.rowCount !== 1 || rows.rows[0].actor_member_id !== actor.memberId || rows.rows[0].kind !== kind || !isDeepStrictEqual(rows.rows[0].details, details))
            throw new CompanyError('conflict');
        return true;
    }
    async function caseReceipt(client, actor, requestId, caseId, fence, kind, details) {
        try {
            await client.query(`INSERT INTO ${S}.claim_receipts(company_id,id,case_id,fence,actor_member_id,kind,details) VALUES($1,$2,$3,$4,$5,$6,$7)`, [actor.companyId, requestId, caseId, fence, actor.memberId, kind, JSON.stringify(details)]);
        }
        catch (error) {
            if (error && typeof error === 'object' && 'code' in error && error.code === '23505')
                throw new CompanyError('conflict');
            throw error;
        }
    }
    async function openCase(client, actor, departmentId, caseId, expectedFence) {
        const result = await client.query(`SELECT *,lease_expires_at>clock_timestamp() AS lease_live FROM ${S}.cases WHERE company_id=$1 AND scope_id=$2 AND id=$3 FOR UPDATE`, [actor.companyId, departmentId, caseId]);
        const row = result.rows[0];
        if (!row)
            throw new CompanyError('not_found');
        if (String(row.fence) !== expectedFence)
            throw new CompanyError('conflict');
        if (row.status === 'claimed' && row.lease_live)
            throw new CompanyError('claim_busy');
        if (row.status === 'claimed' || row.status === 'recovery_required')
            throw new CompanyError('recovery_required');
        if (row.status !== 'open')
            throw new CompanyError('conflict');
        return row;
    }
    return {
        createDepartmentCase(token, input) {
            const departmentId = uuid(input.departmentId), requestId = uuid(input.requestId);
            const title = boundedText(input.title, 240), description = boundedText(input.description, 4000, true);
            const assigneeMemberId = input.assigneeMemberId === null ? null : uuid(input.assigneeMemberId);
            const details = { departmentId, title, description, assigneeMemberId };
            return authenticated(token, async (client, actor) => {
                await requestLock(client, actor, requestId);
                await scopeLock(client, actor, departmentId);
                const found = await selected(client, actor, departmentId);
                if (found.access !== 'write')
                    throw new CompanyError('forbidden');
                if (await priorReceipt(client, actor, requestId, 'department.created_case', details))
                    return { item: await caseResult(client, actor, departmentId, requestId), receiptId: requestId, replayed: true };
                writable(found);
                await assigneeAllowed(client, actor, departmentId, assigneeMemberId);
                const collision = await client.query(`SELECT 1 FROM ${S}.cases WHERE company_id=$1 AND id=$2`, [actor.companyId, requestId]);
                if (collision.rowCount)
                    throw new CompanyError('conflict');
                await insertCaseRecord(client, actor, { id: requestId, scopeId: departmentId, title, description, assigneeMemberId });
                await caseReceipt(client, actor, requestId, requestId, '0', 'department.created_case', details);
                return { item: await caseResult(client, actor, departmentId, requestId), receiptId: requestId, replayed: false };
            });
        },
        assignDepartmentCase(token, input) {
            const departmentId = uuid(input.departmentId), caseId = uuid(input.caseId), requestId = uuid(input.requestId);
            revision(input.expectedFence);
            const assigneeMemberId = input.assigneeMemberId === null ? null : uuid(input.assigneeMemberId);
            const details = { departmentId, caseId, expectedFence: input.expectedFence, assigneeMemberId };
            return authenticated(token, async (client, actor) => {
                await requestLock(client, actor, requestId);
                await scopeLock(client, actor, departmentId);
                const found = await selected(client, actor, departmentId);
                if (found.access !== 'write')
                    throw new CompanyError('forbidden');
                if (await priorReceipt(client, actor, requestId, 'department.assigned', details))
                    return { item: await caseResult(client, actor, departmentId, caseId), receiptId: requestId, replayed: true };
                writable(found);
                await openCase(client, actor, departmentId, caseId, input.expectedFence);
                await assigneeAllowed(client, actor, departmentId, assigneeMemberId);
                const saved = await client.query(`UPDATE ${S}.cases SET assignee_member_id=$4,fence=fence+1 WHERE company_id=$1 AND scope_id=$2 AND id=$3 RETURNING fence`, [actor.companyId, departmentId, caseId, assigneeMemberId]);
                await caseReceipt(client, actor, requestId, caseId, String(saved.rows[0].fence), 'department.assigned', details);
                return { item: await caseResult(client, actor, departmentId, caseId), receiptId: requestId, replayed: false };
            });
        },
        closeDepartmentCase(token, input) {
            const departmentId = uuid(input.departmentId), caseId = uuid(input.caseId), requestId = uuid(input.requestId);
            revision(input.expectedFence);
            if (!['done', 'cancelled'].includes(input.resolution))
                throw new CompanyError('invalid_input');
            const note = boundedText(input.note, 2048);
            const details = { departmentId, caseId, expectedFence: input.expectedFence, resolution: input.resolution, note };
            return authenticated(token, async (client, actor) => {
                await requestLock(client, actor, requestId);
                await scopeLock(client, actor, departmentId);
                const found = await selected(client, actor, departmentId);
                if (found.access !== 'write')
                    throw new CompanyError('forbidden');
                if (await priorReceipt(client, actor, requestId, 'department.closed', details))
                    return { item: await caseResult(client, actor, departmentId, caseId), receiptId: requestId, replayed: true };
                writable(found);
                const row = await openCase(client, actor, departmentId, caseId, input.expectedFence);
                if (actor.role !== 'owner' && row.assignee_member_id !== actor.memberId)
                    throw new CompanyError('forbidden');
                const saved = await client.query(`UPDATE ${S}.cases SET status=$4,fence=fence+1,holder_member_id=NULL,claim_token_hash=NULL,lease_expires_at=NULL,outcome=$5
          WHERE company_id=$1 AND scope_id=$2 AND id=$3 RETURNING fence`, [actor.companyId, departmentId, caseId, input.resolution, JSON.stringify({ kind: 'department.closed', resolution: input.resolution, note, receiptId: requestId })]);
                await caseReceipt(client, actor, requestId, caseId, String(saved.rows[0].fence), 'department.closed', details);
                return { item: await caseResult(client, actor, departmentId, caseId), receiptId: requestId, replayed: false };
            });
        },
        departmentAssignees(token, input) {
            const departmentId = uuid(input.departmentId), offset = input.offset ?? 0;
            page(offset, 100);
            return authenticated(token, async (client, actor) => {
                await scopeLock(client, actor, departmentId);
                const found = await selected(client, actor, departmentId);
                writable(found);
                const result = await client.query(`SELECT m.id,m.display_name,m.role FROM ${S}.members m WHERE m.company_id=$1 AND m.active
          AND (m.role='owner' OR EXISTS(SELECT 1 FROM ${S}.scope_grants g WHERE g.company_id=m.company_id AND g.scope_id=$2 AND g.member_id=m.id AND g.permission='write'))
          ORDER BY lower(m.display_name),m.id LIMIT 101 OFFSET $3`, [actor.companyId, departmentId, offset]);
                return { department: found, members: result.rows.slice(0, 100).map(row => ({ id: row.id, displayName: row.display_name, role: row.role })), offset, hasMore: result.rows.length > 100 };
            });
        },
        setDepartmentLifecycle(token, input) {
            const departmentId = uuid(input.departmentId), requestId = uuid(input.requestId);
            revision(input.expectedRevision);
            if (typeof input.retired !== 'boolean')
                throw new CompanyError('invalid_input');
            const note = boundedText(input.note, 2048);
            const details = { departmentId, expectedRevision: input.expectedRevision, retired: input.retired, note };
            return authenticated(token, async (client, actor) => {
                owner(actor);
                await requestLock(client, actor, requestId);
                await scopeLock(client, actor, departmentId);
                const found = await selected(client, actor, departmentId);
                if (await priorReceipt(client, actor, requestId, 'department.lifecycle', details))
                    return { department: found, receiptId: requestId, replayed: true };
                if (found.revision !== input.expectedRevision || Boolean(found.retiredAt) === input.retired)
                    throw new CompanyError('conflict');
                if (input.retired && found.unresolvedCases !== 0)
                    throw new CompanyError('work_resolution_required');
                await client.query(`UPDATE ${S}.scopes SET revision=revision+1,retired_at=CASE WHEN $3 THEN clock_timestamp() ELSE NULL END,
          retired_by=CASE WHEN $3 THEN $4::uuid ELSE NULL END,retirement_note=CASE WHEN $3 THEN $5 ELSE '' END WHERE company_id=$1 AND id=$2`, [actor.companyId, departmentId, input.retired, actor.memberId, note]);
                await client.query(`INSERT INTO ${S}.audit_events(id,company_id,actor_member_id,kind,details) VALUES($1,$2,$3,'department.lifecycle',$4)`, [requestId, actor.companyId, actor.memberId, JSON.stringify(details)]);
                return { department: await selected(client, actor, departmentId), receiptId: requestId, replayed: false };
            }, true);
        },
        departmentCases(token, input) {
            const id = uuid(input.departmentId), offset = input.offset ?? 0, filter = input.filter ?? 'needs-review';
            page(offset, 20);
            if (!['needs-review', 'all'].includes(filter))
                throw new CompanyError('invalid_input');
            return authenticated(token, async (client, actor) => {
                await scopeLock(client, actor, id);
                const found = await selected(client, actor, id);
                const result = await client.query(`SELECT ${caseColumns} FROM ${S}.cases c ${caseJoins}
          WHERE c.company_id=$1 AND c.scope_id=$2 AND ($4='all' OR c.status='recovery_required' OR (c.status='claimed' AND c.lease_expires_at<=clock_timestamp()))
          ORDER BY c.created_at DESC,c.id LIMIT 21 OFFSET $3`, [actor.companyId, id, offset, filter]);
                return { department: found, cases: result.rows.slice(0, 20).map(row => presentCase(row, actor, found)), canRecover: actor.role === 'owner' && !found.retiredAt, canCreate: found.access === 'write' && !found.retiredAt, filter, offset, hasMore: result.rows.length > 20 };
            });
        },
        recoverDepartmentCase(token, input) {
            const id = uuid(input.departmentId), caseId = uuid(input.caseId), requestId = uuid(input.requestId);
            revision(input.expectedFence);
            if (!['done', 'released'].includes(input.resolution) || typeof input.note !== 'string' || !input.note.trim() || input.note.length > 2048 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(input.note))
                throw new CompanyError('invalid_input');
            const note = input.note.trim();
            return authenticated(token, async (client, actor) => {
                owner(actor);
                await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`department-operation:${actor.companyId}:${requestId}`]);
                await scopeLock(client, actor, id);
                const found = await selected(client, actor, id);
                const receipt = await client.query(`SELECT case_id,kind,details FROM ${S}.claim_receipts WHERE company_id=$1 AND id=$2`, [actor.companyId, requestId]);
                if (receipt.rows[0]) {
                    const previous = receipt.rows[0], details = previous.details;
                    if (previous.case_id !== caseId || previous.kind !== 'department.recovered' || details.departmentId !== id || details.previousFence !== input.expectedFence || details.resolution !== input.resolution || details.note !== note)
                        throw new CompanyError('conflict');
                    return { item: await caseResult(client, actor, id, caseId), receiptId: requestId, replayed: true };
                }
                if ((await client.query(`SELECT 1 FROM ${S}.audit_events WHERE company_id=$1 AND id=$2`, [actor.companyId, requestId])).rowCount)
                    throw new CompanyError('conflict');
                writable(found);
                const result = await client.query(`SELECT *,lease_expires_at>clock_timestamp() AS lease_live FROM ${S}.cases WHERE company_id=$1 AND scope_id=$2 AND id=$3 FOR UPDATE`, [actor.companyId, id, caseId]);
                const row = result.rows[0];
                if (!row)
                    throw new CompanyError('not_found');
                if (String(row.fence) !== input.expectedFence)
                    throw new CompanyError('conflict');
                if (row.status === 'claimed' && row.lease_live)
                    throw new CompanyError('claim_busy');
                if (row.status !== 'recovery_required' && row.status !== 'claimed')
                    throw new CompanyError('conflict');
                // Review is a human reconciliation decision, never proof that an old
                // process stopped. Retire its authority before making work available.
                const saved = await client.query(`UPDATE ${S}.cases SET status=$4,fence=fence+1,claim_token_hash=NULL,lease_expires_at=NULL,holder_member_id=NULL,outcome=$5
          WHERE company_id=$1 AND scope_id=$2 AND id=$3 RETURNING fence`, [actor.companyId, id, caseId, input.resolution === 'done' ? 'done' : 'open', JSON.stringify({ kind: 'department.recovered', resolution: input.resolution, note, receiptId: requestId })]);
                const details = { departmentId: id, previousFence: input.expectedFence, previousHolderMemberId: row.holder_member_id, resolution: input.resolution, note };
                await client.query(`INSERT INTO ${S}.claim_receipts(company_id,id,case_id,fence,actor_member_id,kind,details) VALUES($1,$2,$3,$4,$5,'department.recovered',$6)`, [actor.companyId, requestId, caseId, saved.rows[0].fence, actor.memberId, JSON.stringify(details)]);
                await audit(client, actor, 'department.case_recovered', { caseId, receiptId: requestId, ...details });
                return { item: await caseResult(client, actor, id, caseId), receiptId: requestId, replayed: false };
            });
        },
        listDepartments(token, offset = 0) {
            page(offset, 50);
            return authenticated(token, async (client, actor) => {
                const result = await client.query(`SELECT s.*,(SELECT count(*) FROM ${S}.cases c WHERE c.company_id=s.company_id AND c.scope_id=s.id AND c.status IN ('open','claimed','recovery_required')) AS unresolved_cases,CASE WHEN $3='owner' OR EXISTS(SELECT 1 FROM ${S}.scope_grants g WHERE g.company_id=s.company_id AND g.scope_id=s.id AND g.member_id=$4 AND g.permission='write') THEN 'write' ELSE 'read' END AS access
          FROM ${S}.scopes s WHERE s.company_id=$1 AND s.purpose='department' ORDER BY lower(s.name),s.id LIMIT 51 OFFSET $2`, [actor.companyId, offset, actor.role, actor.memberId]);
                return { departments: result.rows.slice(0, 50).map(department), canManage: actor.role === 'owner', offset, hasMore: result.rows.length > 50 };
            });
        },
        createDepartment(token, input) {
            const id = uuid(input.requestId);
            if (typeof input.name !== 'string' || input.name.length > 120 || /[\x00-\x1f\x7f]/.test(input.name) || !input.name.trim())
                throw new CompanyError('invalid_input');
            const name = input.name.trim();
            return authenticated(token, async (client, actor) => {
                owner(actor);
                const existing = await client.query(`SELECT * FROM ${S}.scopes WHERE company_id=$1 AND id=$2`, [actor.companyId, id]);
                if (existing.rows[0]) {
                    if (existing.rows[0].purpose !== 'department' || existing.rows[0].name !== name)
                        throw new CompanyError('conflict');
                    return selected(client, actor, id);
                }
                try {
                    await client.query(`INSERT INTO ${S}.scopes(company_id,id,owner_member_id,kind,name,purpose) VALUES($1,$2,$3,'team',$4,'department')`, [actor.companyId, id, actor.memberId, name]);
                }
                catch (error) {
                    if (error && typeof error === 'object' && 'code' in error && error.code === '23505')
                        throw new CompanyError('conflict');
                    throw error;
                }
                await audit(client, actor, 'department.created', { departmentId: id, name });
                return selected(client, actor, id);
            }, true);
        },
        departmentAccess(token, input) {
            const id = uuid(input.departmentId), offset = input.offset ?? 0;
            page(offset, 100);
            return authenticated(token, async (client, actor) => {
                owner(actor);
                const found = await selected(client, actor, id);
                const result = await client.query(`SELECT m.id,m.display_name,m.role,
          CASE WHEN m.role='owner' OR bool_or(g.permission='write') THEN 'write' WHEN bool_or(g.permission='read') THEN 'read' ELSE 'none' END AS access
          FROM ${S}.members m LEFT JOIN ${S}.scope_grants g ON g.company_id=m.company_id AND g.member_id=m.id AND g.scope_id=$2
          WHERE m.company_id=$1 AND m.active GROUP BY m.id,m.display_name,m.role ORDER BY lower(m.display_name),m.id LIMIT 101 OFFSET $3`, [actor.companyId, id, offset]);
                return { department: found, offset, hasMore: result.rows.length > 100, members: result.rows.slice(0, 100).map(row => ({ id: String(row.id), displayName: String(row.display_name), role: row.role, access: row.access })) };
            });
        },
        setDepartmentAccess(token, input) {
            const id = uuid(input.departmentId), memberId = uuid(input.memberId);
            if (!['read', 'write', 'none'].includes(input.access) || typeof input.expectedRevision !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(input.expectedRevision) || BigInt(input.expectedRevision) > 9223372036854775807n)
                throw new CompanyError('invalid_input');
            return authenticated(token, async (client, actor) => {
                owner(actor);
                // Lifecycle exclusion makes membership/ownership changes and access edits
                // atomic. The scope lock also serializes protected record operations.
                await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`scope:${actor.companyId}:${id}`]);
                const found = await selected(client, actor, id);
                if (found.revision !== input.expectedRevision)
                    throw new CompanyError('conflict');
                if (found.retiredAt && input.access !== 'none') {
                    const old = await client.query(`SELECT permission FROM ${S}.scope_grants WHERE company_id=$1 AND scope_id=$2 AND member_id=$3`, [actor.companyId, id, memberId]);
                    if (input.access !== 'read' || !old.rows.some(row => row.permission === 'write' || row.permission === 'read'))
                        throw new CompanyError('forbidden');
                }
                const member = await client.query(`SELECT role FROM ${S}.members WHERE company_id=$1 AND id=$2 AND active FOR SHARE`, [actor.companyId, memberId]);
                if (!member.rowCount)
                    throw new CompanyError('not_found');
                if (member.rows[0].role === 'owner')
                    throw new CompanyError('forbidden');
                await client.query(`DELETE FROM ${S}.scope_grants WHERE company_id=$1 AND scope_id=$2 AND member_id=$3`, [actor.companyId, id, memberId]);
                if (input.access !== 'none')
                    await client.query(`INSERT INTO ${S}.scope_grants(company_id,scope_id,member_id,permission) VALUES($1,$2,$3,$4)`, [actor.companyId, id, memberId, input.access]);
                if (input.access !== 'write')
                    await client.query(`UPDATE ${S}.cases SET status='recovery_required',fence=fence+1,claim_token_hash=NULL,lease_expires_at=NULL
          WHERE company_id=$1 AND scope_id=$2 AND holder_member_id=$3 AND status='claimed'`, [actor.companyId, id, memberId]);
                await client.query(`UPDATE ${S}.scopes SET revision=revision+1 WHERE company_id=$1 AND id=$2`, [actor.companyId, id]);
                await audit(client, actor, 'department.access_changed', { departmentId: id, memberId, access: input.access });
                return selected(client, actor, id);
            }, true);
        },
    };
}
