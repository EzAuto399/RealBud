/** Typed, local-only disclosure review. Never serialize a generic execution binding. */
import { createHash, randomUUID } from 'node:crypto';
import { canonicalWebsiteCommand, commandLabel } from "../shared/website-commands.js";
import { remoteExact, remoteIso, isRemoteApproverScope } from "../shared/website-remote-approvers.js";
export const REMOTE_TEMPLATE_KIND = 'remote-review-template';
import { isRemoteDisclosureTemplate } from "../shared/website-remote-disclosure.js";
export { isRemoteDisclosureTemplate } from "../shared/website-remote-disclosure.js";
const digest = (v) => createHash('sha256').update(canonicalWebsiteCommand(v)).digest('hex');
const fail = () => { throw Object.assign(new Error('This disclosure review changed or needs recovery. Review the current plan again.'), { status: 409 }); };
const uuid = (v) => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
export function validateRemoteTemplate(id, v) {
    if (!id.startsWith('remote-template:') || !uuid(id.slice(16)) || !remoteExact(v, ['version', 'workspaceId', 'template', 'digest', 'approved', 'restored', 'createdAt']) || v.version !== 1 || !uuid(v.workspaceId) || !isRemoteDisclosureTemplate(v.template) || v.digest !== digest(v.template) || typeof v.approved !== 'boolean' || typeof v.restored !== 'boolean' || v.restored && v.approved || !remoteIso(v.createdAt))
        return fail();
    return structuredClone(v);
}
export function restoreRemoteTemplate(id, v) { return { ...validateRemoteTemplate(id, v), approved: false, restored: true }; }
export function createRemoteDisclosureReview(options) {
    async function preview(input) {
        if (!remoteExact(input, ['descriptorIds', 'mailboxAlias']) || !Array.isArray(input.descriptorIds) || input.descriptorIds.length < 1 || input.descriptorIds.length > 16 || !input.descriptorIds.every(uuid) || new Set(input.descriptorIds).size !== input.descriptorIds.length || !(input.mailboxAlias === null || commandLabel(input.mailboxAlias, 80)))
            return fail();
        const catalog = await options.catalog();
        const templates = [];
        for (const id of input.descriptorIds) {
            const d = catalog.find(d => d.id === id);
            if (!d)
                return fail();
            const template = await options.capture(d, d.operation === 'morning-review' ? input.mailboxAlias : null);
            if (!isRemoteDisclosureTemplate(template) || canonicalWebsiteCommand(template.descriptor) !== canonicalWebsiteCommand(d))
                return fail();
            templates.push(template);
        }
        const fresh = await options.catalog();
        if (templates.some(t => !fresh.some(d => canonicalWebsiteCommand(d) === canonicalWebsiteCommand(t.descriptor))))
            return fail();
        return options.db.transaction(() => templates.map(template => {
            if (options.db.count(REMOTE_TEMPLATE_KIND) >= 1000)
                throw Object.assign(new Error('Disclosure review history is full. Contact support before adding more.'), { status: 409 });
            const id = `remote-template:${randomUUID()}`;
            const record = { version: 1, workspaceId: options.workspaceId, template, digest: digest(template), approved: false, restored: false, createdAt: new Date().toISOString() };
            validateRemoteTemplate(id, record);
            return options.db.create(REMOTE_TEMPLATE_KIND, id, record, 1000);
        }));
    }
    async function approve(input) {
        if (!remoteExact(input, ['reviews']) || !Array.isArray(input.reviews) || input.reviews.length < 1 || input.reviews.length > 16 || new Set(input.reviews.map(r => r.id)).size !== input.reviews.length || !input.reviews.every(r => remoteExact(r, ['id', 'revision', 'digest']) && typeof r.id === 'string' && Number.isSafeInteger(r.revision) && r.revision > 0 && typeof r.digest === 'string'))
            return fail();
        const rows = input.reviews.map(ref => { const row = options.db.get(REMOTE_TEMPLATE_KIND, ref.id); if (!row || !(row.revision === ref.revision || row.revision === ref.revision + 1 && row.value.approved) || row.value.digest !== ref.digest)
            return fail(); validateRemoteTemplate(row.id, row.value); if (row.value.restored || row.value.workspaceId !== options.workspaceId)
            return fail(); return row; });
        for (const row of rows) {
            const fresh = await options.capture(row.value.template.descriptor, row.value.template.mailboxAlias);
            if (digest(fresh) !== row.value.digest)
                return fail();
        }
        return options.db.transaction(() => rows.map(row => {
            if (!row.value.approved)
                options.db.update(REMOTE_TEMPLATE_KIND, row.id, row.revision, value => ({ ...value, approved: true }));
            return { descriptorId: row.value.template.descriptor.id, descriptorRevision: row.value.template.descriptor.revision, disclosureDigest: row.value.digest };
        }));
    }
    async function approvedTemplate(scope) {
        if (!isRemoteApproverScope(scope))
            return fail();
        const rows = [];
        let before;
        do {
            const page = options.db.page(REMOTE_TEMPLATE_KIND, { before, limit: 200 });
            rows.push(...page.records.filter(r => r.value.digest === scope.disclosureDigest));
            before = page.next ?? undefined;
        } while (before);
        const row = rows.find(r => !r.value.restored && r.value.approved && r.value.workspaceId === options.workspaceId && r.value.template.descriptor.id === scope.descriptorId && r.value.template.descriptor.revision === scope.descriptorRevision);
        if (!row)
            return fail();
        validateRemoteTemplate(row.id, row.value);
        const current = await options.capture(row.value.template.descriptor, row.value.template.mailboxAlias);
        if (!isRemoteDisclosureTemplate(current) || digest(current) !== scope.disclosureDigest)
            return fail();
        return structuredClone(current);
    }
    async function requireApproved(scopes) {
        for (const scope of scopes)
            await approvedTemplate(scope);
    }
    return { preview, approve, requireApproved, approvedTemplate };
}
