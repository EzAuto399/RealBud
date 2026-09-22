import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { LoopManager, nextOccurrence } from './routines.ts';
import { runMorningMailWorkflow } from './morning-mail-workflow.ts';
import type { JobRun, LoopRun, Recipe } from '../shared/contracts.ts';
import type { MailScanReceipt, MailWorkspaceMetadata } from '../shared/mail-ingestion.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function file() { const root = mkdtempSync(join(tmpdir(), 'rb-mail-clock-')); roots.push(root); return join(root, 'loops.json'); }
const recipe = { id: 'wf-austin-accounts-inbox-triage', revision: 1, approvedRevision: 1, status: 'active', planApprovedAt: 1 } as Recipe;
function pipeline(count = 1) {
  let remaining = count;
  const receipt = { id: 'fictional-source', status: 'complete', threadCount: count } as MailScanReceipt;
  const state: MailWorkspaceMetadata = { version: 2, revision: 1, latestScan: receipt,
    latestReview: null, nextSnoozeAt: null,
    counts: { total: count, open: count, waiting: 0, reference: 0, snoozed: 0, done: 0,
      highPriority: 0, needsReview: count } };
  const deps = { recipe: () => recipe, admitPack: vi.fn(async () => {}), collect: vi.fn(async () => state),
    prepareInput: vi.fn(async () => remaining > 0 ? { ...receipt, batchThreadCount: Math.min(20, remaining) } : null),
    execute: vi.fn(async () => ({ run: { id: `fictional-job-${remaining}`, status: 'awaiting-approval' } as JobRun })),
    applyReview: vi.fn(async () => { remaining -= Math.min(20, remaining); return state; }) };
  return { deps, receipt, state };
}

describe('morning mailbox production clock and pipeline boundary', () => {
  it('runs an explicit paused-clock request once and preserves its idempotent receipt across restart', async () => {
    const { deps } = pipeline(), path = file(), now = Date.parse('2026-09-21T22:00:00Z');
    const execute = vi.fn(async (_loop: unknown, run: LoopRun) => runMorningMailWorkflow(run, deps));
    const options = { file: path, now: () => now, hostTimezone: 'UTC', execute };
    const manager = new LoopManager(options);
    manager.setEnabled('morning-arrears', false); manager.setEnabled('owner-letter', false);
    const loop = manager.listLoops().find(row => row.id === 'inbound-triage')!;
    const request = { requestId: randomUUID(), expectedRevision: loop.revision };
    const run = manager.runNow(loop.id, request)!;
    await manager.tick();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(deps.collect).toHaveBeenCalledTimes(1);
    const execution = deps.execute.mock.calls as unknown as Array<[Recipe, { trigger: string; loopRunId: string }]>;
    expect(execution[0][1]).toMatchObject({ trigger: 'manual', loopRunId: run.id });
    expect(manager.listLoops().find(row => row.id === loop.id)?.enabled).toBe(false);
    const restarted = new LoopManager(options);
    expect(restarted.runNow(loop.id, request)?.id).toBe(run.id); await restarted.tick();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(restarted.listRuns().find(row => row.id === run.id)?.status).toBe('awaiting-approval');
  });

  it('runs at the configured office morning even when the host and UTC weekday differ', async () => {
    const { deps } = pipeline(); let now = Date.parse('2026-09-20T21:59:00Z');
    const execute = vi.fn(async (_loop: unknown, run: LoopRun) => runMorningMailWorkflow(run, deps));
    const manager = new LoopManager({ file: file(), now: () => now, hostTimezone: 'America/New_York', execute });
    manager.setEnabled('morning-arrears', false); manager.setEnabled('owner-letter', false);
    const loop = manager.patchClock('inbound-triage', { enabled: true, time: '08:00', weekdays: [1], timezone: 'Australia/Brisbane' });
    expect(loop.nextRunAt).toBe(Date.parse('2026-09-20T22:00:00Z'));
    now = Date.parse('2026-09-20T22:00:01Z'); await manager.tick(); await manager.tick();
    expect(execute).toHaveBeenCalledTimes(1);
    const execution = deps.execute.mock.calls as unknown as Array<[Recipe, { trigger: string; scheduledFor: number }]>;
    expect(execution[0][1]).toMatchObject({ trigger: 'schedule', scheduledFor: Date.parse('2026-09-20T22:00:00Z') });
  });

  it('never invents a different wall-clock time when the chosen minute does not exist during DST', () => {
    const result = nextOccurrence({ type: 'daily', time: '02:30', weekdays: [0], timezone: 'Australia/Sydney' }, Date.parse('2026-10-03T14:00:00Z'), 'Australia/Sydney');
    expect(result).toBe(Date.parse('2026-10-10T15:30:00Z'));
  });

  it('rechecks the reviewed plan after pending source collection before starting a model', async () => {
    const { deps, state } = pipeline(); let changed = false;
    deps.recipe = () => changed ? { ...recipe, revision: 2, approvedRevision: 2 } : recipe;
    deps.collect = vi.fn(async () => { changed = true; return state; });
    expect(await runMorningMailWorkflow({ id: 'clock-a', scheduledFor: 1, manual: true } as LoopRun, deps)).toMatchObject({ ok: false, status: 'failed' });
    expect(deps.execute).not.toHaveBeenCalled(); expect(deps.applyReview).not.toHaveBeenCalled();
  });

  it('reports already persisted batches as partial if a later review adoption fails', async () => {
    const { deps } = pipeline(25);
    const apply = deps.applyReview.getMockImplementation()!;
    let calls = 0; deps.applyReview = vi.fn(async () => { if (++calls === 2) throw new Error('Synthetic source changed'); return apply(); });
    const result = await runMorningMailWorkflow({ id: 'clock-a', scheduledFor: 1, manual: true } as LoopRun, deps);
    expect(result).toMatchObject({ ok: false, status: 'partial', jobRunId: 'fictional-job-5' });
    expect(deps.execute).toHaveBeenCalledTimes(2);
  });

  it('never starts a sixth model batch even when evidence remains', async () => {
    const { deps } = pipeline(101);
    expect(await runMorningMailWorkflow({ id: 'clock-a', scheduledFor: 1, manual: false } as LoopRun, deps)).toMatchObject({ ok: false, status: 'partial' });
    expect(deps.execute).toHaveBeenCalledTimes(5); expect(deps.collect).toHaveBeenCalledTimes(1);
  });
});
