/** Inert enrollment history only. Challenges, credentials and pending confirmations are excluded. */
import { canonicalWebsiteCommand, commandUuid } from "../shared/website-commands.js";
import { isRemoteApproverGrant, isRemoteApproverPerson, isRemoteApproverScope, remoteExact, remoteIso } from "../shared/website-remote-approvers.js";
export const REMOTE_EVIDENCE_KIND = 'remote-enrollment-history';
const same = (a, b) => canonicalWebsiteCommand(a) === canonicalWebsiteCommand(b);
export function validateRemoteEvidence(id, v) {
    const fail = () => { throw Object.assign(new Error('Remote access history needs recovery.'), { status: 503 }); };
    if (!remoteExact(v, ['version', 'workspaceId', 'enrollmentId', 'scopes', 'candidate', 'approver', 'phase', 'restored', 'updatedAt']) || v.version !== 1 || typeof v.workspaceId !== 'string' || !commandUuid.test(v.workspaceId) || typeof v.enrollmentId !== 'string' || !commandUuid.test(v.enrollmentId) || id !== `remote-enrollment:${v.enrollmentId}` || !Array.isArray(v.scopes) || v.scopes.length < 1 || v.scopes.length > 16 || !v.scopes.every(isRemoteApproverScope) || new Set(v.scopes.map(s => s.descriptorId)).size !== v.scopes.length || !(v.candidate === null || isRemoteApproverPerson(v.candidate)) || !(v.approver === null || isRemoteApproverGrant(v.approver)) || typeof v.phase !== 'string' || !['publishing', 'pending', 'candidate', 'confirmed', 'revoking', 'revoked', 'expired', 'stale', 'disabled', 'historical'].includes(v.phase) || typeof v.restored !== 'boolean' || v.restored && v.phase !== 'historical' || !remoteIso(v.updatedAt))
        return fail();
    if (v.approver && (v.approver.workspaceId !== v.workspaceId || v.approver.id !== v.enrollmentId || !same(v.approver.scopes, v.scopes) || !same(v.approver.person, v.candidate)))
        return fail();
    return structuredClone(v);
}
export function restoreRemoteEvidence(id, v) { return { ...validateRemoteEvidence(id, v), restored: true, phase: 'historical' }; }
export function recordRemoteEvidence(db, event) {
    const id = `remote-enrollment:${event.enrollmentId}`;
    const value = { version: 1, workspaceId: event.workspaceId, enrollmentId: event.enrollmentId, scopes: event.scopes, candidate: event.snapshot?.candidate ?? null, approver: event.snapshot?.approver ?? null, phase: event.phase, restored: false, updatedAt: new Date().toISOString() };
    validateRemoteEvidence(id, value);
    const row = db.get(REMOTE_EVIDENCE_KIND, id);
    if (row) {
        validateRemoteEvidence(id, row.value);
        if (row.value.restored || row.value.workspaceId !== value.workspaceId)
            throw Object.assign(new Error('Historical enrollment cannot be reactivated.'), { status: 409 });
        if (same({ ...row.value, updatedAt: '' }, { ...value, updatedAt: '' }))
            return;
        db.update(REMOTE_EVIDENCE_KIND, id, row.revision, () => value);
    }
    else
        db.create(REMOTE_EVIDENCE_KIND, id, value, 5000);
}
