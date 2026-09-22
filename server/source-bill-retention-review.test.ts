import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WorkflowDatabase } from './workflow-database.ts';
import { previewBillSource, SourceBillRegister } from './source-bills.ts';
import type { BillMailSource } from '../shared/source-bills.ts';

const roots: string[] = [], databases: WorkflowDatabase[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const database of databases.splice(0)) database.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'rb-bill-cache-review-')); roots.push(directory);
  const database = new WorkflowDatabase({ dir: directory, key: randomBytes(32) }); databases.push(database);
  const register = new SourceBillRegister(database, { dataDir: directory });
  const source: BillMailSource = { accountId: 'fictional-account', receiptId: 'fictional-receipt', threadId: 'fictional-thread', message: { id: 'fictional-message', at: 1, from: 'fixture@example.invalid', subject: 'Fictional bill', body: 'Fictional bill source', attachments: [] } };
  const input = { expectedSourceDigest: previewBillSource(source).digest, sourceReviewed: true, facts: { propertyId: 'fictional-property', kind: 'Water', vendor: 'Fictional Water', currency: 'AUD', amountCents: 1000, invoiceDate: null, dueDate: null, note: '' }, reviewReason: 'Fictional staff review' };
  return { directory, database, register, source, input };
}

describe('independent source-bill transaction cache review', () => {
  it('does not bless an external write occurring after commit as already validated', () => {
    const f = fixture(), bill = f.register.accept(f.input, f.source, 'fictional-reviewer');
    const raw = new DatabaseSync(join(f.directory, 'workflow-state.sqlite'));
    const transaction = f.database.transaction.bind(f.database);
    let depth = 0, inject = true;
    vi.spyOn(f.database, 'transaction').mockImplementation(operation => {
      depth++;
      try {
        const result = transaction(operation);
        if (depth === 1 && inject) {
          inject = false;
          // A separate SQLite handle commits between the completed transaction
          // and its caller receiving the result. This is deterministic setup
          // for the cross-process boundary, not a timed interleaving guess.
          expect(raw.prepare("DELETE FROM workflow_records WHERE kind='bill-source-alias'").run().changes).toBe(1);
        }
        return result;
      } finally { depth--; }
    });
    try {
      expect(f.register.counts().occurrences).toBe(1);
      expect(() => f.register.getOccurrence(bill.id)).toThrow(/recovery/i);
      expect(raw.prepare("SELECT COUNT(*) AS count FROM workflow_records WHERE kind='bill-source-alias'").get()).toMatchObject({ count: 0 });
    } finally { raw.close(); }
  });

  it('invalidates derived counts when an enclosing transaction rolls back a completed register change', () => {
    const f = fixture();
    expect(f.register.occurrencePage({ propertyId: 'fictional-property' }).total).toBe(0);
    expect(() => f.database.transaction(() => {
      f.register.accept(f.input, f.source, 'fictional-reviewer');
      expect(f.register.occurrencePage({ propertyId: 'fictional-property' }).total).toBe(1);
      throw Object.assign(new Error('Fictional enclosing work failed'), { status: 409 });
    })).toThrow('Fictional enclosing work failed');
    const page = f.register.occurrencePage({ propertyId: 'fictional-property' });
    expect(page.total).toBe(0); expect(page.items).toEqual([]);
    expect(f.register.counts().occurrences).toBe(0);
    expect(f.register.findBySourceIdentity(previewBillSource(f.source).identity)).toBeUndefined();
    const saved = f.register.accept(f.input, f.source, 'fictional-reviewer');
    expect(saved.revision).toBe(1); expect(f.register.occurrencePage({ propertyId: 'fictional-property' }).total).toBe(1);
  });
});
