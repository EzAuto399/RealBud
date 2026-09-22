import { randomUUID } from 'node:crypto';
import { defaultAgencySettings } from '../agency-setup.ts';
import { buildMailSourceInput, mailEvidenceHash, type StoredMailWorkspace } from '../mail-workspace-integrity.ts';
import { parseMailScanResult, type MailScanReceipt, type MailScanRequest, type MailWorkItem } from '../../shared/mail-ingestion.ts';
import type { AgencySetupSettings } from '../../shared/agency-setup.ts';

/** A fixed version-one writer projection, independent of the current storage
 * implementation. Keeping this fixture legacy protects real upgrade archives. */
export function legacyMailBackupFixture(workspaceId: string, now: number) {
  const settings = { ...defaultAgencySettings(), workflowPackId: 'office-core', agencyName: 'Fictional practice', timeZone: 'Australia/Brisbane',
    gmailAccountId: 'fictional-mail', selectedWorkflows: ['morning-priorities'] } satisfies AgencySetupSettings;
  const request: MailScanRequest = { windowStartAt: now - settings.mailScope.historyDays * 86_400_000, windowEndAt: now,
    maxMessages: settings.mailScope.maxMessages, includeSent: settings.mailScope.includeSent, carryThreadIds: [] };
  const data = parseMailScanResult({ accountId: settings.gmailAccountId, windowStartAt: request.windowStartAt, windowEndAt: request.windowEndAt,
    pages: 1, paginationComplete: true, gaps: [], threads: [{ id: 'abc', historyComplete: true, messages: [{ id: 'aa', threadId: 'abc', at: now - 1000,
      direction: 'incoming', from: 'sender@example.test', to: 'accounts@example.test', subject: 'Fictional maintenance',
      body: 'Please review this fictional repair. 保留原始證據。', bodyTruncated: false, attachments: [] }] }] }, request, settings.gmailAccountId);
  const receipt: MailScanReceipt = { id: randomUUID(), accountId: settings.gmailAccountId, bindingRevision: 'a'.repeat(64), startedAt: now,
    completedAt: now, windowStartAt: request.windowStartAt, windowEndAt: request.windowEndAt, status: 'complete', messageCount: 1,
    threadCount: 1, pages: 1, gaps: [], inputDigest: null };
  const fullInput = buildMailSourceInput(workspaceId, receipt, data, settings); receipt.inputDigest = mailEvidenceHash(fullInput);
  const sourceReference = `realbud-mail:${receipt.id}:${mailEvidenceHash(fullInput.threads).slice(0, 16)}`;
  const input = { ...fullInput, sourceReference, threadCount: 1, maxThreads: 20,
    reviewBatch: { selectedThreadCount: 1, collectedThreadCount: 1, pendingThreadCount: 1 },
    coverage: { ...fullInput.coverage, accounts: fullInput.coverage.accounts.map(account => ({ ...account, expectedThreadCount: 1, returnedThreadCount: 1 })) } };
  const item: MailWorkItem = { id: mailEvidenceHash([workspaceId, settings.gmailAccountId, 'abc']), revision: 2, accountId: settings.gmailAccountId,
    threadId: 'abc', subject: data.threads[0].messages[0].subject, sourceMessageIds: ['aa'], sourceDigest: mailEvidenceHash(data.threads[0]),
    sourceReceiptId: receipt.id, disposition: 'hold', priority: 'high', owner: 'unassigned', reason: 'New conversation collected; its meaning has not been reviewed.',
    nextAction: 'Review the source or ask Bud to prepare the morning list.', missingFacts: [], status: 'done', snoozedUntil: null,
    note: 'Keep this human decision.', reviewed: true, newEvidence: false, firstSeenAt: now, updatedAt: now, lastMessageAt: now - 1000 };
  const state: StoredMailWorkspace = { version: 1, workspaceId, revision: 3, latestScan: receipt, latestReview: null, receipts: [receipt], items: [item] };
  const source = { version: 1, workspaceId, request, data, settings };
  const prepared = { receiptId: receipt.id, sourceReference, digest: mailEvidenceHash(input) };
  return { state, source, prepared, input, settings, request, data, receipt, item };
}
