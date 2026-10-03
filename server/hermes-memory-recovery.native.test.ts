/** Actual admitted native helper + host service; all data and keys fictional. */
import { afterEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtemp, realpath, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHermesMemoryReviewService, type MemoryReviewContext } from './hermes-memory-review.ts';
import { MEMORY_RECOVERY_API as api, type MemoryRecoveryPage } from '../shared/hermes-memory-recovery.ts';
import { MEMORY_REVIEW_API, type MemoryReviewPreview } from '../shared/hermes-memory-review.ts';
import type { MemoryProposalInput } from '../shared/hermes-memory-proposal.ts';
import { MEMORY_REVIEW_CANDIDATE_RUNTIME } from './hermes-memory-review.ts';
import { prepareNativeMemoryFixture } from './testing/native-memory-fixture.ts';
import { prepareInterruptedMemoryFixture } from './testing/memory-prepared-fixture.mjs';

const runtime = process.env.REALBUD_TEST_HERMES_RUNTIME;
const helperPath = fileURLToPath(new URL('./helpers/hermes-memory-review.py', import.meta.url));
const roots: string[] = [], services: ReturnType<typeof createHermesMemoryReviewService>[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

const addInput = { requestId: 'fictional-interrupted-preference', payload: { action: 'add' as const, target: 'memory' as const, content: 'Fictional preference for weekly summaries.' } };
async function fixture(input: MemoryProposalInput = addInput) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'realbud-interrupted-test-'))); roots.push(directory);
  const f = await prepareNativeMemoryFixture(directory, runtime!);
  const context: MemoryReviewContext = { profileDirectory: f.profile, runtimeDirectory: f.runtime, runtimeId: f.runtimeId,
    workspaceId: '77777777-7777-4777-8777-777777777777', profileId: 'property', python: join(f.runtime, 'venv/bin/python') };
  const rootKey = Buffer.alloc(32, 41);
  const open = () => { const service = createHermesMemoryReviewService({ context: () => context, key: () => rootKey }); services.push(service); return service; };
  const service = open(), capability = service.proposalIntegration('fictional-interrupted-chat', () => true)!;
  const key = createHmac('sha256', rootKey).update(`realbud-memory-review-v1\0${context.workspaceId}\0${context.profileId}`).digest();
  const { python, ...binding } = context;
  let proposalKey: string;
  try { proposalKey = prepareInterruptedMemoryFixture({ python, helperPath, request: { ...binding, version: 1, command: 'propose', scopeId: capability.scope, input, key: key.toString('base64') } }); }
  finally { key.fill(0); }
  return { ...f, context, service, open, proposalKey, capability, input, journal: join(f.profile, '.realbud-memory-reviews', 'proposals', proposalKey! + '.json') };
}

describe.skipIf(!runtime || process.platform === 'win32')('interrupted closure through host and actual native Hermes', () => {
  it('discovers a real crash, closes once, survives service restart and stops same-request publication', async () => {
    const f = await fixture(), before = await readFile(f.memoryFile);
    const listed = await f.service.handle(api, 'GET'); expect(listed?.status).toBe(200);
    const row = (listed!.body as MemoryRecoveryPage).items[0];
    expect(row).toMatchObject({ key: f.proposalKey, state: 'interrupted', closedAt: null }); expect(row.recoveryDigest).toMatch(/^[a-f0-9]{64}$/);
    const original = JSON.parse(await readFile(f.journal, 'utf8'));
    expect(await f.service.handle(`${api}/${row.key}/close`, 'POST', { expectedDigest: 'a'.repeat(64) })).toMatchObject({ status: 409, body: { code: 'stale-review' } });
    expect(JSON.parse(await readFile(f.journal, 'utf8'))).toEqual(original);
    const closure = await f.service.handle(`${api}/${row.key}/close`, 'POST', { expectedDigest: row.recoveryDigest });
    expect(closure).toMatchObject({ status: 200, body: { key: row.key, state: 'closed', recoveryDigest: row.recoveryDigest } });
    const closed = JSON.parse(await readFile(f.journal, 'utf8'));
    for (const field of Object.keys(original).filter(field => !['version', 'state', 'mac'].includes(field))) expect(closed[field]).toEqual(original[field]);
    expect(closed).toMatchObject({ version: 2, state: 'closed', recoveryDigest: row.recoveryDigest });
    expect(await readFile(f.memoryFile)).toEqual(before); expect(await readdir(f.pendingDirectory)).toEqual([]);
    expect(await f.service.handle(MEMORY_REVIEW_API, 'GET')).toMatchObject({ status: 200, body: { items: [] } });
    await f.service.close(); const restarted = f.open();
    expect(await restarted.handle(`${api}/${row.key}/close`, 'POST', { expectedDigest: row.recoveryDigest })).toEqual(closure);
    expect(await restarted.handle(api, 'GET')).toMatchObject({ status: 200, body: { items: [{ key: row.key, state: 'closed', recoveryDigest: row.recoveryDigest }] } });
    await expect(restarted.proposalIntegration('fictional-interrupted-chat', () => true)!.propose(f.input, new AbortController().signal)).rejects.toMatchObject({ code: 'proposal-closed' });
    expect(await readFile(f.memoryFile)).toEqual(before); expect(await readdir(f.pendingDirectory)).toEqual([]);
  }, 60000);

  it('can close metadata when memory configuration is disabled or malformed', async () => {
    const f = await fixture(), before = await readFile(f.memoryFile);
    await f.privateWrite(join(f.profile, 'config.yaml'), 'memory: [');
    const response = await f.service.handle(api, 'GET'); expect(response?.status).toBe(200);
    const row = (response!.body as MemoryRecoveryPage).items[0];
    expect(await f.service.handle(`${api}/${row.key}/close`, 'POST', { expectedDigest: row.recoveryDigest })).toMatchObject({ status: 200, body: { state: 'closed' } });
    expect(await readFile(f.memoryFile)).toEqual(before);
  }, 60000);

  it('republishes an interrupted removal only from bytes matching its journal, pinned on the pinning runtime', async () => {
    const removal: MemoryProposalInput = { requestId: 'fictional-interrupted-removal', payload: { action: 'remove', target: 'memory', old_text: 'concise' } };
    const f = await fixture(removal), original = await readFile(f.memoryFile, 'utf8'), journal = await readFile(f.journal);
    // The entry moved after preparation: the journaled proposal cannot be reproduced, nothing is published.
    await f.privateWrite(f.memoryFile, 'Prefers brief updates.\n§\nUse Australian English.');
    await expect(f.capability.propose(removal, new AbortController().signal)).rejects.toMatchObject({ code: 'conflict' });
    expect(await readFile(f.journal)).toEqual(journal); expect(await readdir(f.pendingDirectory)).toEqual([]);
    expect(await f.service.handle(api, 'GET')).toMatchObject({ status: 200, body: { items: [{ key: f.proposalKey, state: 'interrupted' }] } });
    // Restored memory reproduces the exact bytes; the same request completes publication once.
    await f.privateWrite(f.memoryFile, original);
    const result = await f.capability.propose(removal, new AbortController().signal);
    const staged = JSON.parse(await readFile(join(f.pendingDirectory, result.id + '.json'), 'utf8'));
    expect(staged.payload).toEqual(f.commit === MEMORY_REVIEW_CANDIDATE_RUNTIME ? { ...removal.payload, matched_entry: 'Prefers concise updates.' } : removal.payload);
    expect(await f.capability.propose(removal, new AbortController().signal)).toEqual(result);
    expect(await f.service.handle(api, 'GET')).toMatchObject({ status: 200, body: { items: [] } });
    const review = (await f.service.handle(`${MEMORY_REVIEW_API}/${result.id}`, 'GET'))!.body as MemoryReviewPreview; expect(review.after).toBe('Use Australian English.');
    expect(await f.service.handle(`${MEMORY_REVIEW_API}/${result.id}/decision`, 'POST', { expectedDigest: review.reviewDigest, decision: 'approve' })).toMatchObject({ status: 200, body: { state: 'applied' } });
    expect(await readFile(f.memoryFile, 'utf8')).toBe('Use Australian English.');
  }, 60000);

  it('holds closure if an artifact appears after the displayed inventory', async () => {
    const f = await fixture(), before = await readFile(f.memoryFile);
    const row = ((await f.service.handle(api, 'GET'))!.body as MemoryRecoveryPage).items[0];
    const saved = await readFile(f.journal), nativeId = JSON.parse(saved.toString()).id;
    const foreign = join(f.pendingDirectory, nativeId + '.json'); await f.privateWrite(foreign, '{"fictional":"keep"}');
    expect(await f.service.handle(`${api}/${row.key}/close`, 'POST', { expectedDigest: row.recoveryDigest })).toMatchObject({ status: 409, body: { code: 'conflict' } });
    expect(await readFile(f.journal)).toEqual(saved); expect(await readFile(foreign, 'utf8')).toBe('{"fictional":"keep"}');
    expect(await readFile(f.memoryFile)).toEqual(before);
    expect(await f.service.handle(api, 'GET')).toMatchObject({ status: 200, body: { items: [{ key: row.key, state: 'recovery-required', recoveryDigest: null }] } });
  }, 60000);
});
