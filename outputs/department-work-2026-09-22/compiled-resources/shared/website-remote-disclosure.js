/** Browser-safe complete disclosure contract; private execution bindings are excluded. */
import { commandLabel, isWebsiteCommandDescriptor } from "./website-commands.js";
import { remoteExact, REMOTE_DISCLOSURE_POLICY } from "./website-remote-approvers.js";
export function isRemoteDisclosureTemplate(v) {
    return remoteExact(v, ['version', 'policy', 'descriptor', 'mailboxAlias', 'sections']) && v.version === 1 && v.policy === REMOTE_DISCLOSURE_POLICY && isWebsiteCommandDescriptor(v.descriptor) && (v.mailboxAlias === null || commandLabel(v.mailboxAlias, 80)) && (v.descriptor.operation === 'morning-review' ? v.mailboxAlias !== null : v.mailboxAlias === null) && Array.isArray(v.sections) && v.sections.length > 0 && v.sections.length <= 64 && v.sections.every(s => remoteExact(s, ['label', 'value']) && commandLabel(s.label, 160) && typeof s.value === 'string' && s.value.length <= 8000 && !/[\u0000\u000b\u000c]/.test(s.value)) && new TextEncoder().encode(JSON.stringify(v)).byteLength <= 60_000;
}
