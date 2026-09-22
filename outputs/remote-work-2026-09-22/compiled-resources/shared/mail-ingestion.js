const record = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const bounded = (v, max) => typeof v === 'string' && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);
export const gmailThreadId = (v) => typeof v === 'string' && /^[a-fA-F0-9]{1,64}$/.test(v);
const bad = () => { throw Object.assign(new Error('The mail source or its coverage needs review.'), { status: 400 }); };
export function parseMailScanRequest(value, now = Date.now()) {
    if (!record(value) || Object.keys(value).sort().join(',') !== 'carryThreadIds,includeSent,maxMessages,windowEndAt,windowStartAt' ||
        !Number.isSafeInteger(value.windowStartAt) || !Number.isSafeInteger(value.windowEndAt) || Number(value.windowStartAt) < 0 ||
        Number(value.windowEndAt) <= Number(value.windowStartAt) || Number(value.windowEndAt) > now + 60_000 ||
        Number(value.windowEndAt) - Number(value.windowStartAt) > 90 * 86_400_000 ||
        !Number.isInteger(value.maxMessages) || Number(value.maxMessages) < 1 || Number(value.maxMessages) > 500 ||
        typeof value.includeSent !== 'boolean' || !Array.isArray(value.carryThreadIds) || value.carryThreadIds.length > 100 ||
        value.carryThreadIds.some(v => !gmailThreadId(v)) || new Set(value.carryThreadIds).size !== value.carryThreadIds.length)
        return bad();
    return structuredClone(value);
}
/** Validate at both the remote transport and durable-storage boundary. */
export function parseMailScanResult(value, request, accountId) {
    if (!record(value) || value.accountId !== accountId || value.windowStartAt !== request.windowStartAt || value.windowEndAt !== request.windowEndAt ||
        !Array.isArray(value.threads) || value.threads.length > 100 || !Number.isInteger(value.pages) || Number(value.pages) < 0 || Number(value.pages) > 20 ||
        typeof value.paginationComplete !== 'boolean' || !Array.isArray(value.gaps) || value.gaps.length > 200 || value.gaps.some(v => !bounded(v, 200)))
        return bad();
    const threadIds = new Set(), messageIds = new Set();
    let count = 0;
    const threads = value.threads.map(row => {
        if (!record(row) || !gmailThreadId(row.id) || threadIds.has(row.id) || typeof row.historyComplete !== 'boolean' || !Array.isArray(row.messages) || !row.messages.length || row.messages.length > 100)
            return bad();
        threadIds.add(row.id);
        const messages = row.messages.map(m => {
            if (!record(m) || !gmailThreadId(m.id) || m.threadId !== row.id || messageIds.has(m.id) || !Number.isSafeInteger(m.at) || Number(m.at) < 0 || Number(m.at) >= request.windowEndAt ||
                !['incoming', 'outgoing', 'unknown'].includes(String(m.direction)) || !bounded(m.from, 2048) || !bounded(m.to, 2048) || !bounded(m.subject, 2048) || !bounded(m.body, 12_000) ||
                typeof m.bodyTruncated !== 'boolean' || !Array.isArray(m.attachments) || m.attachments.length > 100 || ++count > request.maxMessages)
                return bad();
            messageIds.add(m.id);
            const attachments = m.attachments.map(a => {
                if (!record(a) || !bounded(a.id, 512) || !a.id || !bounded(a.name, 255) || !bounded(a.mimeType, 120) ||
                    (a.size !== null && (!Number.isSafeInteger(a.size) || Number(a.size) < 0)))
                    return bad();
                return { id: a.id, name: a.name, mimeType: a.mimeType, size: a.size };
            });
            return { id: m.id, threadId: String(row.id), at: Number(m.at), direction: m.direction, from: m.from, to: m.to,
                subject: m.subject, body: m.body, bodyTruncated: m.bodyTruncated, attachments };
        });
        return { id: row.id, messages: messages.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)), historyComplete: row.historyComplete };
    });
    const result = { accountId, windowStartAt: request.windowStartAt, windowEndAt: request.windowEndAt, threads, pages: Number(value.pages), paginationComplete: value.paginationComplete, gaps: value.gaps };
    if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 800_000 || (result.paginationComplete && result.pages === 0) || (!result.paginationComplete && !result.gaps.length) ||
        (threads.some(t => !t.historyComplete || t.messages.some(m => m.bodyTruncated || m.direction === 'unknown' || m.attachments.length)) && !result.gaps.length))
        return bad();
    return result;
}
export function mailWorkGroup(item) {
    if (item.status !== 'open')
        return item.status;
    if (item.disposition === 'waiting')
        return 'waiting';
    if (item.disposition === 'reference' || item.disposition === 'noise')
        return 'reference';
    return 'open';
}
