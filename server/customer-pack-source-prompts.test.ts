import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Recipe } from '../shared/contracts.ts';
import type { InboxReview, InvoiceReview } from '../shared/accounts-review.ts';
import type { MailScanReceipt, MailScanResult } from '../shared/mail-ingestion.ts';
import { defaultAgencySettings } from './agency-setup.ts';
import { billProposalInput } from './bill-proposal-validation.ts';
import { austinCustomerPack } from './customer-pack-definition.ts';
import { executeRecipeJob } from './job-executor.ts';
import { JobRunStore } from './job-runs.ts';
import { buildMailSourceInput } from './mail-workspace-integrity.ts';
import { previewBillSource } from './source-bill-rules.ts';
import { plantPrivateFile, privateTempRoot, removeFixture } from './testing/private-fixture.ts';

const fixtures: { directory: string; store: JobRunStore }[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.store.close();
    await removeFixture(fixture.directory);
  }
});

// These are fictional records using the production connected-source builders.
// No connector, installed profile, model or account is accessed by this test.
const now = Date.parse('2026-10-01T00:00:00Z');
const settings = { ...defaultAgencySettings(), agencyName: 'Fictional source office', timeZone: 'Australia/Brisbane' };
const message = { id: 'fictional-message', threadId: 'fictional-thread', at: now - 1000, direction: 'incoming' as const,
  from: 'supplier@example.test', to: 'office@example.test', subject: 'Fictional source for review',
  body: 'Please review the fictional source. No payment is confirmed.', bodyTruncated: false, attachments: [] };

function source(kind: 'inbox' | 'invoice') {
  if (kind === 'inbox') {
    const data: MailScanResult = { accountId: 'fictional-account', windowStartAt: now - 86400000, windowEndAt: now,
      threads: [{ id: message.threadId, historyComplete: true, messages: [message] }], pages: 1, paginationComplete: true, gaps: [] };
    const receipt: MailScanReceipt = { id: 'fictional-scan', accountId: data.accountId, bindingRevision: 'a'.repeat(64),
      startedAt: now, completedAt: now, windowStartAt: data.windowStartAt, windowEndAt: now,
      status: 'complete', pages: 1, gaps: [], threadCount: 1, messageCount: 1, inputDigest: null };
    const input = buildMailSourceInput('fictional-workspace', receipt, data, settings);
    const review: InboxReview = { version: 1, kind: 'accounts-inbox-triage', sourceReference: input.sourceReference,
      status: 'complete', coverageComplete: true, skillSource: 'email-inbox-triage@0.1.0', holds: [], actionsPerformed: [],
      threads: [{ threadId: message.threadId, disposition: 'action-review', owner: 'accounts-reviewer', priority: 'normal',
        sourceMessageIds: [message.id], reason: 'The saved source requests internal review.', nextAction: 'Review the source.', missingFacts: [] }] };
    return { recipeId: 'wf-austin-accounts-inbox-triage', file: 'accounts-inbox.json', input, review };
  }
  const savedSource = previewBillSource({ accountId: 'fictional-account', receiptId: 'fictional-scan', threadId: message.threadId, message });
  const input = billProposalInput(settings, savedSource, new Date(now).toISOString());
  const review: InvoiceReview = { version: 1, kind: 'accounts-invoice-entry-review', sourceReference: String(input.sourceReference),
    status: 'partial', coverageComplete: false, holds: [{ itemId: 'coverage', reason: 'Only one saved message was supplied.' }], actionsPerformed: [],
    documents: [{ documentId: `mail-${savedSource.identity}`, decision: 'hold', duplicateOf: null, conflictGroup: null,
      proposedEntry: { supplierId: null, invoiceId: null, propertyId: null, amount: null, currency: null, dueDate: null, costType: null },
      sourceIds: [message.id], reason: 'The saved message lacks invoice facts.' }] };
  return { recipeId: 'wf-austin-accounts-invoice-review', file: 'accounts-invoices.json', input, review };
}

describe('published Auston preparation source provenance', () => {
  it.each([
    ['inbox', false], ['invoice', false], ['inbox', true], ['invoice', true],
  ] as const)('constructs the actual %s worker prompt with synthetic=%s and preserves its source contract', async (kind, synthetic) => {
    const fixture = source(kind);
    const directory = privateTempRoot(join(tmpdir(), 'rb-pack-source-prompt-'));
    const store = new JobRunStore({ file: join(directory, 'runs.json'), now: () => now });
    fixtures.push({ directory, store });
    const input = synthetic ? { ...fixture.input, synthetic: true } : fixture.input;
    const path = join(directory, 'workflow-inputs', fixture.file);
    plantPrivateFile(path, JSON.stringify(input));
    if (kind === 'inbox') expect(input).toMatchObject({ reviewer: { scenario: 'connected-mail' } });
    else expect(input).toMatchObject({ coverage: { complete: false, failedSources: [expect.stringContaining('Selected saved message only')] } });
    expect(input).not.toHaveProperty('synthetic', false);

    const definition = austinCustomerPack().recipes.find(recipe => recipe.id === fixture.recipeId)!;
    const recipe: Recipe = { ...definition, revision: 7, status: 'active', planApprovedAt: now - 1, approvedRevision: 7,
      createdAt: now - 2, updatedAt: now - 1, attachment: null, submitAcknowledgedAt: null };
    const before = structuredClone(recipe);
    const ask = vi.fn(async (prompt: string, options: { toolsets?: string[] } = {}) => {
      expect(prompt).toContain(`Description: ${definition.description}`);
      expect(prompt).toContain('only when input.synthetic=true; otherwise call it saved-source evidence');
      expect(prompt).toContain('does not verify live freshness or complete coverage');
      expect(prompt).not.toMatch(/all QA data is synthetic|PROPOSED SYNTHETIC OFFICE ROUTING POLICY/);
      expect(prompt).toContain(`workflow-inputs/${fixture.file}`);
      expect(prompt).toContain('Those prohibitions cannot be overridden by approval in this job');
      expect(prompt).toContain('must not send or communicate externally; submit a portal form; pay or move trust money');
      expect(prompt).toContain('change PMS or portal records');
      expect(options.toolsets).toEqual(['file']);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(input);
      return { ok: true as const, stdout: JSON.stringify({ summary: 'Fictional worker result', evidence: [], outputs: [JSON.stringify(fixture.review)], needsApproval: [] }) };
    });
    const request = { mode: 'prepare' as const, trigger: 'manual' as const, idempotencyKey: 'fictional-source-review' };
    const result = await executeRecipeJob(recipe, request, { store, workroom: directory, ask });
    expect(result.run.status).toBe('awaiting-approval');
    expect(result.run.detail).toContain(synthetic ? 'Synthetic rehearsal.' : 'Saved-source review.');
    expect(result.run.evidence.some(row => row.kind === 'output' && row.note.includes(fixture.review.sourceReference))).toBe(true);
    expect(result.run.spec.description).toBe(definition.description);
    expect(recipe).toEqual(before);
    expect((await executeRecipeJob(recipe, request, { store, workroom: directory, ask })).reused).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
  });
});
