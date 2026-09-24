export const MEMORY_PROPOSAL_REVIEW_LOCATION = 'You → Bud → Bud’s memory';
export const MEMORY_PROPOSAL_INPUT_BYTES = 64 * 1024;
const textBytes = 128 * 1024;
const encoder = new TextEncoder();
const controls = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
// With Unicode mode, valid surrogate pairs are a single code point outside this range.
const unpairedSurrogate = /[\ud800-\udfff]/u;
const object = (value) => !!value && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const fields = (value, names) => Reflect.ownKeys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
function text(value) {
    return typeof value === 'string' && value.trim().length > 0 && encoder.encode(value).byteLength <= textBytes && !controls.test(value) && !unpairedSurrogate.test(value);
}
function operation(value, withTarget) {
    if (!object(value))
        return null;
    const extra = withTarget ? ['target'] : [];
    if (value.action === 'add' && fields(value, [...extra, 'action', 'content']) && text(value.content))
        return { action: 'add', content: value.content };
    if (value.action === 'replace' && fields(value, [...extra, 'action', 'content', 'old_text']) && text(value.content) && text(value.old_text))
        return { action: 'replace', content: value.content, old_text: value.old_text };
    if (value.action === 'remove' && fields(value, [...extra, 'action', 'old_text']) && text(value.old_text))
        return { action: 'remove', old_text: value.old_text };
    return null;
}
export function parseMemoryProposalInput(value) {
    if (!object(value) || !fields(value, ['requestId', 'payload']) || typeof value.requestId !== 'string' || value.requestId !== value.requestId.trim() || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value.requestId) || !object(value.payload))
        return null;
    const raw = value.payload, target = raw.target;
    if (target !== 'memory' && target !== 'user')
        return null;
    let payload;
    if (raw.action === 'batch') {
        if (!fields(raw, ['target', 'action', 'operations']) || !Array.isArray(raw.operations) || raw.operations.length < 1 || raw.operations.length > 100)
            return null;
        const operations = [];
        for (const item of raw.operations) {
            const parsed = operation(item, false);
            if (!parsed)
                return null;
            operations.push(parsed);
        }
        payload = { target, action: 'batch', operations };
    }
    else {
        const parsed = operation(raw, true);
        if (!parsed)
            return null;
        payload = { target, ...parsed };
    }
    const parsed = { requestId: value.requestId, payload };
    return encoder.encode(JSON.stringify(parsed)).byteLength <= MEMORY_PROPOSAL_INPUT_BYTES ? parsed : null;
}
export function parseMemoryProposalResult(value) {
    if (!object(value) || !fields(value, ['version', 'id', 'reviewLocation']) || value.version !== 1 || typeof value.id !== 'string' || value.id.length !== 8 || !/^[a-f0-9]{8}$/.test(value.id) || value.reviewLocation !== MEMORY_PROPOSAL_REVIEW_LOCATION)
        return null;
    return { version: 1, id: value.id, reviewLocation: MEMORY_PROPOSAL_REVIEW_LOCATION };
}
