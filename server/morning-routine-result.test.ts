import { afterEach, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkflowDatabase } from './workflow-database.ts';
import { recordMorningResult } from './morning-routine-result.ts';
import { latestRoutineResult } from './routine-results.ts';
import { removeFixture } from './testing/private-fixture.ts';
import type { LoopRun } from '../shared/contracts.ts';
import type { MailWorkspaceMetadata } from '../shared/mail-ingestion.ts';
const clean: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of clean.splice(0)) await close(); });
it('saves source-specific morning results, keeps unchanged runs quiet across restart, and surfaces new evidence or gaps', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rb-morning-result-'));
  let db = new WorkflowDatabase({ dir, key: Buffer.alloc(32, 6) });
  clean.push(async () => { db.close(); await removeFixture(dir); });
  const state: MailWorkspaceMetadata & { resultKey: string } = { version: 2, revision: 1, latestReview: null, nextSnoozeAt: null, resultKey: 'a'.repeat(64),
    counts: { total: 3, open: 2, waiting: 1, reference: 0, snoozed: 0, done: 0, highPriority: 1, needsReview: 0 },
    latestScan: { id: randomUUID(), accountId: 'fictional-mail', bindingRevision: 'fictional-binding', startedAt: 10, completedAt: 20,
      windowStartAt: 1, windowEndAt: 10, status: 'complete', messageCount: 3, threadCount: 3, pages: 1, gaps: [], inputDigest: 'b'.repeat(64) } };
  const finish = () => recordMorningResult(db, { id: randomUUID() } as LoopRun, { ok: true, status: 'awaiting-approval', detail: 'Fixture' }, state, { elapsedMs: 2, modelCalls: 1 }, 20);
  expect(finish()).toMatchObject({ quiet: false, status: 'awaiting-approval' });
  expect(latestRoutineResult(db, 'inbound-triage')?.detail).toContain('2 open, 1 waiting, 1 high priority');
  db.close(); db = new WorkflowDatabase({ dir, key: Buffer.alloc(32, 6) }); state.latestScan!.id = randomUUID();
  expect(finish().quiet).toBe(true);
  state.resultKey = 'c'.repeat(64); expect(finish().quiet).toBe(false);
  state.latestScan!.status = 'partial'; state.latestScan!.gaps = ['Fictional missing sent context'];
  expect(recordMorningResult(db, { id: randomUUID() } as LoopRun, { ok: true, status: 'partial', detail: 'Fixture' }, state, { elapsedMs: 2, modelCalls: 0 }, 20)).toMatchObject({ quiet: false, status: 'partial' });
});
it('records how many conversations Jev screened and its model id, never cost', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rb-morning-screen-'));
  const db = new WorkflowDatabase({ dir, key: Buffer.alloc(32, 6) });
  clean.push(async () => { db.close(); await removeFixture(dir); });
  const state: MailWorkspaceMetadata & { resultKey: string } = { version: 2, revision: 1, latestReview: null, nextSnoozeAt: null, resultKey: 'a'.repeat(64),
    counts: { total: 3, open: 1, waiting: 0, reference: 2, snoozed: 0, done: 0, highPriority: 0, needsReview: 0 },
    latestScan: { id: randomUUID(), accountId: 'fictional-mail', bindingRevision: 'fictional-binding', startedAt: 10, completedAt: 20,
      windowStartAt: 1, windowEndAt: 10, status: 'complete', messageCount: 3, threadCount: 3, pages: 1, gaps: [], inputDigest: 'b'.repeat(64) } };
  const screen = { screened: 2, model: 'typesafe/jev-1.13-20260917' };
  expect(recordMorningResult(db, { id: randomUUID() } as LoopRun, { ok: true, detail: 'Fixture' }, state, { elapsedMs: 2, modelCalls: 1, screen }, 20).detail).toContain('2 screened as noise');
  expect(latestRoutineResult(db, 'inbound-triage')).toMatchObject({ screen, metrics: { elapsedMs: 2, modelCalls: 1 } });
  state.resultKey = 'c'.repeat(64);
  recordMorningResult(db, { id: randomUUID() } as LoopRun, { ok: true, detail: 'Fixture' }, state, { elapsedMs: 2, modelCalls: 1, screen: null }, 21);
  expect(latestRoutineResult(db, 'inbound-triage')).not.toHaveProperty('screen');
});
