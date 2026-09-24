import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, vi } from 'vitest';
import type { WorkBatch } from '../../shared/batches.ts';
import { BatchService } from '../batches.ts';
import { Desk } from '../desk.ts';

/** Fictional legacy-format work with exact evidence and an unfinished retry. */
export function batchBackupFixture(): WorkBatch[] {
  return [{ id: 'fictional-batch', requestKey: 'fixture-request-01', requestHash: 'a'.repeat(64), revision: 7, task: 'owner-update',
    instruction: 'Fictional retained instruction', status: 'running', retryOnly: false, autoContinue: true, waitingForWorker: true,
    detail: 'Waiting for the worker', sourceRevision: 3, sample: true, createdAt: 10, updatedAt: 20,
    items: [
      { propertyId: 'prop-oak', address: '12 Fictional Road', source: '\uFEFF  Original\r\n私人 source  ', status: 'ready', attempt: 1, output: '  Completed draft — café\r\n', detail: 'Ready', gaps: ['Confirm a date'], reviewedAt: 19 },
      { propertyId: 'prop-pine', address: '8 Fictional Lane', source: 'Unfinished source', status: 'running', attempt: 2, output: 'Partial draft', detail: 'Running', gaps: [], retryAt: 99_999 },
      { propertyId: 'prop-elm', address: '5 Fictional Street', source: 'Queued source', status: 'queued', attempt: 0, output: '', detail: 'Queued', gaps: [], retryAt: 99_999 },
    ] }];
}

/** Exercises the production reader and explicit continuation against restored
 * files. The worker is deterministic; this is not live model evidence. */
export async function verifyRestoredBatchReader(directory: string, key: Buffer) {
  const file = join(directory, 'work-batches.json'), original = batchBackupFixture()[0];
  const saved = JSON.parse(readFileSync(file, 'utf8')) as WorkBatch[];
  expect(saved[0]).toMatchObject({ id: original.id, requestKey: original.requestKey, requestHash: original.requestHash,
    revision: 8, sourceRevision: 3, status: 'paused', autoContinue: false, waitingForWorker: false });
  expect(saved[0].items[0]).toEqual(original.items[0]);
  expect(saved[0].items[1]).toMatchObject({ status: 'interrupted', source: original.items[1].source, output: 'Partial draft', attempt: 2 });
  expect(saved[0].items[2]).toMatchObject({ status: 'queued', source: original.items[2].source, attempt: 0 });
  expect(saved[0].items.every(item => item.retryAt === undefined)).toBe(true);
  const desk = new Desk({ file: join(directory, 'desk.json'), key, vaultDir: join(directory, 'vault') });
  expect(desk.snapshot().recovery.active).toBe(false);
  const available = vi.fn(async () => true), ask = vi.fn(async () => ({ ok: true as const,
    stdout: JSON.stringify({ summary: 'Fictional resumed result', evidence: ['Fixture source'], outputs: ['Fictional new draft'], needsApproval: [] }), detail: '' }));
  const deps = { file, snapshot: () => desk.snapshot(), notes: () => '', available, ask, retryDelayMs: 0 };
  const service = new BatchService(deps);
  try {
    await Promise.resolve(); await service.recoverReadyWork();
    expect(service.get(original.id)).toEqual(saved[0]); expect(available).not.toHaveBeenCalled(); expect(ask).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(saved);
    service.control(original.id, 'resume', saved[0].revision); await service.wait(original.id);
    let current = service.get(original.id); expect(ask).toHaveBeenCalledTimes(1);
    expect(current.items[0]).toEqual(original.items[0]); expect(current.items[1].status).toBe('interrupted'); expect(current.items[2].status).toBe('ready');
    service.control(original.id, 'retry-failed', current.revision); await service.wait(original.id);
    current = service.get(original.id); expect(ask).toHaveBeenCalledTimes(2);
    expect(current.items[0]).toEqual(original.items[0]); expect(current.items[1].attempt).toBe(3); expect(current.items[2].attempt).toBe(1);
    expect(current.status).toBe('finished'); expect(current.requestHash).toBe(original.requestHash); expect(current.requestKey).toBe(original.requestKey);
    service.stop();
    const reopened = new BatchService(deps);
    try { await Promise.resolve(); await reopened.recoverReadyWork(); expect(reopened.get(original.id)).toEqual(current); expect(ask).toHaveBeenCalledTimes(2); }
    finally { reopened.stop(); }
  } finally { service.stop(); }
}
