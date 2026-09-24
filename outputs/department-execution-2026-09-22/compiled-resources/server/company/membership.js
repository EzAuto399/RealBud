import { createHash, randomUUID } from 'node:crypto';
import { CompanyError } from "./types.js";
const S = 'realbud_company';
const uuid = (value) => {
    if (typeof value !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value))
        throw new CompanyError('invalid_input');
    return value.toLowerCase();
};
const date = (value) => value?.toISOString() ?? null;
export function createMembershipApi({ authenticated, transaction }) {
    function receiptHash(value) {
        if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value))
            throw new CompanyError('invalid_input');
        return createHash('sha256').update(value).digest('hex');
    }
    async function unresolved(client, actor) {
        const assigned = await client.query(`SELECT ${S}.actor_has_department_work() AS assigned`);
        if (assigned.rows[0]?.assigned)
            return true;
        const result = await client.query(`SELECT 1 FROM ${S}.cases c JOIN ${S}.scopes s ON s.company_id=c.company_id AND s.id=c.scope_id
      LEFT JOIN LATERAL (SELECT content::jsonb AS body FROM ${S}.knowledge_revisions k WHERE k.company_id=c.company_id AND k.scope_id=c.scope_id AND k.key='realbud-work-item:v1' ORDER BY revision DESC LIMIT 1) w ON true
      WHERE c.company_id=$1 AND ((c.holder_member_id=$2 AND c.status IN ('claimed','recovery_required')) OR
        (s.purpose='department' AND c.assignee_member_id=$2 AND c.status IN ('open','claimed','recovery_required')) OR
        (w.body IS NOT NULL AND COALESCE(w.body->>'state','')<>'closed' AND (s.owner_member_id=$2 OR w.body->>'assigneeMemberId'=$2::text))) LIMIT 1`, [actor.companyId, actor.memberId]);
        return Boolean(result.rowCount);
    }
    async function audit(client, actor, kind, details) {
        await client.query(`INSERT INTO ${S}.audit_events(id,company_id,actor_member_id,kind,details) VALUES($1,$2,$3,$4,$5)`, [randomUUID(), actor.companyId, actor.memberId, kind, JSON.stringify(details)]);
    }
    return {
        membershipManagement(token, offset = 0) {
            if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000 || offset % 100 !== 0)
                throw new CompanyError('invalid_input');
            return authenticated(token, async (client, actor) => {
                const members = actor.role === 'owner' ? await client.query(`SELECT id,display_name,role,active,created_at FROM ${S}.members WHERE company_id=$1 ORDER BY created_at,id LIMIT 101 OFFSET $2`, [actor.companyId, offset]) : { rows: [] };
                const invitations = actor.role === 'owner' ? await client.query(`SELECT id,display_name,expires_at,redeemed_at,revoked_at FROM ${S}.invitations WHERE company_id=$1 ORDER BY expires_at DESC,id LIMIT 101 OFFSET $2`, [actor.companyId, offset]) : { rows: [] };
                const transfer = await client.query(`SELECT id,from_member_id,to_member_id,expires_at FROM ${S}.ownership_transfers WHERE company_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp() AND (from_member_id=$2 OR to_member_id=$2)`, [actor.companyId, actor.memberId]);
                const row = transfer.rows[0];
                return { offset, hasMore: members.rows.length > 100 || invitations.rows.length > 100, unresolvedWork: await unresolved(client, actor),
                    members: members.rows.slice(0, 100).map(row => ({ id: row.id, displayName: row.display_name, role: row.role, active: row.active, joinedAt: date(row.created_at) })),
                    invitations: invitations.rows.slice(0, 100).map(row => ({ id: row.id, displayName: row.display_name, expiresAt: date(row.expires_at), redeemedAt: date(row.redeemed_at), revokedAt: date(row.revoked_at) })),
                    transfer: row ? { id: row.id, fromMemberId: row.from_member_id, toMemberId: row.to_member_id, expiresAt: date(row.expires_at) } : null,
                };
            });
        },
        offerOwnership(token, memberId) {
            uuid(memberId);
            return authenticated(token, async (client, actor) => {
                if (actor.role !== 'owner' || memberId === actor.memberId)
                    throw new CompanyError('forbidden');
                const target = await client.query(`SELECT 1 FROM ${S}.members WHERE company_id=$1 AND id=$2 AND active AND role='member'`, [actor.companyId, memberId]);
                if (!target.rowCount)
                    throw new CompanyError('not_found');
                const id = randomUUID();
                await client.query(`INSERT INTO ${S}.ownership_transfers(company_id,id,from_member_id,to_member_id,expires_at) VALUES($1,$2,$3,$4,clock_timestamp()+interval '24 hours')
          ON CONFLICT(company_id) DO UPDATE SET id=EXCLUDED.id,from_member_id=EXCLUDED.from_member_id,to_member_id=EXCLUDED.to_member_id,expires_at=EXCLUDED.expires_at,accepted_at=NULL,revoked_at=NULL`, [actor.companyId, id, actor.memberId, memberId]);
                await audit(client, actor, 'ownership.offered', { id, memberId });
                return { id };
            }, true);
        },
        cancelOwnership(token, transferId) {
            uuid(transferId);
            return authenticated(token, async (client, actor) => {
                const result = await client.query(`UPDATE ${S}.ownership_transfers SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE company_id=$1 AND id=$2 AND accepted_at IS NULL AND (from_member_id=$3 OR to_member_id=$3) RETURNING id`, [actor.companyId, transferId, actor.memberId]);
                if (!result.rowCount)
                    throw new CompanyError('conflict');
                await audit(client, actor, 'ownership.cancelled', { id: transferId });
            }, true);
        },
        acceptOwnership(token, transferId) {
            uuid(transferId);
            return authenticated(token, async (client, actor) => {
                const found = await client.query(`SELECT * FROM ${S}.ownership_transfers WHERE company_id=$1 AND id=$2 AND to_member_id=$3 AND revoked_at IS NULL AND (accepted_at IS NOT NULL OR expires_at>clock_timestamp())`, [actor.companyId, transferId, actor.memberId]);
                const offer = found.rows[0];
                if (!offer)
                    throw new CompanyError('conflict');
                if (offer.accepted_at && actor.role === 'owner')
                    return;
                if (actor.role !== 'member' || offer.accepted_at)
                    throw new CompanyError('conflict');
                const old = await client.query(`UPDATE ${S}.members SET role='member' WHERE company_id=$1 AND id=$2 AND role='owner' AND active RETURNING id`, [actor.companyId, offer.from_member_id]);
                if (!old.rowCount)
                    throw new CompanyError('conflict');
                await client.query(`UPDATE ${S}.members SET role='owner' WHERE company_id=$1 AND id=$2 AND active`, [actor.companyId, actor.memberId]);
                // Department write access follows current ownership. Fence claims whose
                // former owner just lost that authority, under the lifecycle exclusion.
                // An explicit write grant survives transfer and keeps its valid lease.
                const held = await client.query(`UPDATE ${S}.cases c SET status='recovery_required',fence=fence+1,claim_token_hash=NULL,lease_expires_at=NULL
          FROM ${S}.scopes s WHERE c.company_id=$1 AND c.holder_member_id=$2 AND c.status='claimed'
          AND s.company_id=c.company_id AND s.id=c.scope_id AND s.purpose='department'
          AND NOT EXISTS(SELECT 1 FROM ${S}.scope_grants g WHERE g.company_id=c.company_id AND g.scope_id=c.scope_id AND g.member_id=$2 AND g.permission='write')`, [actor.companyId, offer.from_member_id]);
                // Only company scopes transfer. Private scopes and knowledge never do.
                await client.query(`UPDATE ${S}.scopes SET owner_member_id=$2,revision=revision+1 WHERE company_id=$1 AND kind='company'`, [actor.companyId, actor.memberId]);
                await client.query(`UPDATE ${S}.ownership_transfers SET accepted_at=clock_timestamp() WHERE company_id=$1 AND id=$2`, [actor.companyId, transferId]);
                await client.query(`UPDATE ${S}.invitations SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE company_id=$1 AND redeemed_at IS NULL`, [actor.companyId]);
                await audit(client, actor, 'ownership.accepted', { id: transferId, previousOwner: offer.from_member_id, heldDepartmentCases: held.rowCount });
            }, true);
        },
        departureStatus(operationToken) {
            const hash = receiptHash(operationToken);
            return transaction(async (client) => ({ completed: Boolean((await client.query(`SELECT 1 FROM ${S}.departure_receipts WHERE operation_hash=$1`, [hash])).rowCount) }));
        },
        leaveMembership(token, operationToken) {
            const hash = receiptHash(operationToken);
            return authenticated(token, async (client, actor) => {
                if (actor.role === 'owner')
                    throw new CompanyError('owner_transfer_required');
                if (await unresolved(client, actor))
                    throw new CompanyError('work_resolution_required');
                await client.query(`UPDATE ${S}.members SET active=false WHERE company_id=$1 AND id=$2`, [actor.companyId, actor.memberId]);
                await client.query(`UPDATE ${S}.sessions SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE company_id=$1 AND member_id=$2`, [actor.companyId, actor.memberId]);
                await client.query(`UPDATE ${S}.cases SET status='recovery_required',fence=fence+1,claim_token_hash=NULL,lease_expires_at=NULL WHERE company_id=$1 AND holder_member_id=$2 AND status='claimed'`, [actor.companyId, actor.memberId]);
                await audit(client, actor, 'membership.left', {});
                await client.query(`INSERT INTO ${S}.departure_receipts(operation_hash,company_id,member_id) VALUES($1,$2,$3)`, [hash, actor.companyId, actor.memberId]);
            }, true);
        },
    };
}
