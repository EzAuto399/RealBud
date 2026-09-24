// Shared by live mail journals and portable-backup validation. These pure
// checks and the evidence projection must agree before a saved source is usable.
import { createHash } from 'node:crypto';
import { gmailThreadId } from "../shared/mail-ingestion.js";
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v, max) => typeof v === 'string' && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);
const at = (v) => Number.isSafeInteger(v) && Number(v) >= 0;
const HEX = /^[a-f0-9]{64}$/;
export const mailEvidenceHash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function validMailReceipt(r) {
    return object(r) && typeof r.id === 'string' && /^[a-f0-9-]{36}$/.test(r.id) && typeof r.accountId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(r.accountId) &&
        typeof r.bindingRevision === 'string' && HEX.test(r.bindingRevision) && at(r.startedAt) && (r.completedAt === null || at(r.completedAt)) &&
        at(r.windowStartAt) && at(r.windowEndAt) && r.windowEndAt > r.windowStartAt && ['running', 'complete', 'partial', 'failed', 'interrupted'].includes(r.status) &&
        Number.isInteger(r.messageCount) && r.messageCount >= 0 && r.messageCount <= 500 && Number.isInteger(r.threadCount) && r.threadCount >= 0 && r.threadCount <= 100 &&
        Number.isInteger(r.pages) && r.pages >= 0 && r.pages <= 20 && Array.isArray(r.gaps) && r.gaps.length <= 200 && r.gaps.every((g) => text(g, 200)) && (r.inputDigest === null || typeof r.inputDigest === 'string' && HEX.test(r.inputDigest));
}
export function validMailWorkItem(i, workspaceId) {
    return object(i) && typeof i.accountId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(i.accountId) && gmailThreadId(i.threadId) && i.id === mailEvidenceHash([workspaceId, i.accountId, i.threadId]) &&
        Number.isSafeInteger(i.revision) && i.revision > 0 && text(i.subject, 2048) && typeof i.sourceDigest === 'string' && HEX.test(i.sourceDigest) && typeof i.sourceReceiptId === 'string' && /^[a-f0-9-]{36}$/.test(i.sourceReceiptId) &&
        Array.isArray(i.sourceMessageIds) && i.sourceMessageIds.length > 0 && i.sourceMessageIds.length <= 100 && i.sourceMessageIds.every(gmailThreadId) && new Set(i.sourceMessageIds).size === i.sourceMessageIds.length &&
        ['urgent-review', 'reply-review', 'action-review', 'waiting', 'reference', 'noise', 'hold'].includes(i.disposition) && ['high', 'normal', 'low'].includes(i.priority) && text(i.owner, 120) &&
        text(i.reason, 2000) && text(i.nextAction, 2000) && Array.isArray(i.missingFacts) && i.missingFacts.length <= 100 && i.missingFacts.every((s) => text(s, 2000)) &&
        ['open', 'done', 'snoozed'].includes(i.status) && (i.snoozedUntil === null || at(i.snoozedUntil)) && (i.status !== 'snoozed' || i.snoozedUntil !== null) && text(i.note, 2000) &&
        typeof i.reviewed === 'boolean' && typeof i.newEvidence === 'boolean' &&
        (!Object.hasOwn(i, 'followUpReviewedKey') || typeof i.followUpReviewedKey === 'string' && HEX.test(i.followUpReviewedKey)) &&
        at(i.firstSeenAt) && at(i.updatedAt) && at(i.lastMessageAt);
}
export function validMailWorkspace(value, workspaceId) {
    return !(!object(value) || value.version !== 1 || value.workspaceId !== workspaceId || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
        !Array.isArray(value.receipts) || value.receipts.length > 1000 || value.receipts.some(r => !validMailReceipt(r)) || new Set(value.receipts.map(r => r.id)).size !== value.receipts.length ||
        (value.latestScan !== null && (!validMailReceipt(value.latestScan) || !value.receipts.some(r => JSON.stringify(r) === JSON.stringify(value.latestScan)))) ||
        !Array.isArray(value.items) || value.items.length > 2000 || value.items.some(i => !validMailWorkItem(i, workspaceId)) || new Set(value.items.map(i => i.id)).size !== value.items.length ||
        (value.latestReview !== null && (!object(value.latestReview) || !text(value.latestReview.runId, 128) || !at(value.latestReview.at) || !value.receipts.some(r => r.id === value.latestReview.sourceReceiptId))));
}
export const buildMailSourceInput = (workspaceId, r, data, settings) => ({
    version: 1, sourceReference: `realbud-mail:${r.id}`, asOf: new Date(r.windowEndAt).toISOString(), timezone: settings.timeZone,
    agency: { name: settings.agencyName, workspaceId: workspaceId },
    reviewer: { role: 'accounts-reviewer', scenario: 'connected-mail' },
    coverage: { complete: r.status === 'complete', agreedAccounts: [r.accountId], from: new Date(r.windowStartAt).toISOString(), toExclusive: new Date(r.windowEndAt).toISOString(),
        accounts: [{ accountId: r.accountId, folders: settings.mailScope.includeSent ? ['inbox', 'sent'] : ['inbox'], expectedThreadCount: data.threads.length,
                returnedThreadCount: data.threads.length, paginationComplete: data.paginationComplete && !data.gaps.length, pageIds: Array.from({ length: data.pages }, (_, i) => i + 1), failedPages: [], threadHistoryComplete: data.threads.every(t => t.historyComplete) }],
        failedSources: data.gaps.filter(g => !g.startsWith('Attachment')), missingAttachments: data.threads.flatMap(t => t.messages.flatMap(m => m.attachments.map(a => `${m.id}:${a.id}`))) },
    threadCount: data.threads.length, maxThreads: 100,
    threads: data.threads.map(t => ({ threadId: t.id, accountId: r.accountId, subject: t.messages.at(-1)?.subject ?? '',
        historyComplete: t.historyComplete && t.messages.every(m => !m.bodyTruncated && m.direction !== 'unknown'),
        messages: t.messages.map(m => ({ messageId: m.id, direction: m.direction, senderRole: m.direction === 'outgoing' ? 'accounts-reviewer' : 'unverified sender', sender: m.from, recipient: m.to, sentAt: new Date(m.at).toISOString(), body: m.body })),
        attachmentIds: t.messages.flatMap(m => m.attachments.map(a => `${m.id}:${a.id}`)) })),
    attachments: data.threads.flatMap(t => t.messages.flatMap(m => m.attachments.map(a => ({ id: `${m.id}:${a.id}`, fileName: a.name, status: 'not-read' })))),
    allowedAttachmentPaths: [], propertyReferences: settings.propertyReferences,
    priorityPreferences: { unansweredFollowUpAfterDays: settings.morningReview.followUpAfterDays, note: 'Rank internal review only. Unverified dates, intent, property mapping and unread attachments remain explicit holds. Do not invent due dates or send messages.' },
});
