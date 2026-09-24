import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createBillProposals } from '../bill-proposals.ts';
import { defaultAgencySettings } from '../agency-setup.ts';
import { previewBillSource } from '../source-bills.ts';
import type { WorkflowDatabase } from '../workflow-database.ts';
import type { BillMailSource } from '../../shared/source-bills.ts';
import type { Recipe } from '../../shared/contracts.ts';

/** Generate an actual retained pre-dispatch intent from fictional source data.
 * The executor deliberately stops before worker input or external work. */
export async function proposalBackupFixture(db: WorkflowDatabase, directory: string) {
  const source: BillMailSource = { accountId: 'fictional-mail', receiptId: 'fictional-scan', threadId: 'abc123', message: {
    id: 'ab12', at: 1_780_000_000_000, from: 'fictional@example.invalid', subject: 'Fictional invoice',
    body: 'Fictional utility invoice for human review.', bodyTruncated: false, attachments: [],
  } };
  const authority = { settings: { ...defaultAgencySettings(), agencyName: 'Fictional agency', workflowPackId: 'office-core' as const,
    gmailAccountId: source.accountId, timeZone: 'Australia/Brisbane', propertyReferences: [] },
    evidenceDigest: 'b'.repeat(64), packBinding: 'c'.repeat(64),
    recipe: { id: 'wf-office-core-invoice-review', revision: 2, approvedRevision: 2, planApprovedAt: 1, status: 'active' } as Recipe };
  const request = { requestId: randomUUID(), itemId: 'a'.repeat(64), messageId: source.message.id, expectedSourceDigest: previewBillSource(source).digest };
  const options = { database: () => db, workroom: join(directory, 'vault'), epoch: () => 'fixture',
    authorize: async () => structuredClone(authority), source: async () => structuredClone(source), runs: () => [],
    execute: async (): Promise<never> => { throw new Error('Fictional stop before worker admission'); },
  };
  await assert.rejects(createBillProposals(options)(request), /Fictional stop before worker admission/);
  const id = `bill-proposal:${request.requestId}`, record = db.get('bill-proposal', id);
  assert.ok(record);
  return { id, record, request, options };
}
