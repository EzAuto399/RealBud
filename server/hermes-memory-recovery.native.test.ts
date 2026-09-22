/** Actual admitted native helper + host service; all data and keys fictional. */
import { afterEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtemp, realpath, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHermesMemoryReviewService, MEMORY_REVIEW_RUNTIME, type MemoryReviewContext } from './hermes-memory-review.ts';
import { MEMORY_RECOVERY_API as api, type MemoryRecoveryPage } from '../shared/hermes-memory-recovery.ts';
import { MEMORY_REVIEW_API } from '../shared/hermes-memory-review.ts';
import { prepareNativeMemoryFixture } from './testing/native-memory-fixture.ts';
import { prepareInterruptedMemoryFixture } from './testing/memory-prepared-fixture.mjs';

const runtime = process.env.REALBUD_TEST_HERMES_RUNTIME;
const helperPath = fileURLToPath(new URL('./helpers/hermes-memory-review.py', import.meta.url));
const roots: string[] = [], services: ReturnType<typeof createHermesMemoryReviewService>[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'realbud-interrupted-test-'))); roots.push(directory);
  const f = await prepareNativeMemoryFixture(directory, runtime!);
  const context: MemoryReviewContext = { profileDirectory: f.profile, runtimeDirectory: f.runtime, runtimeId: MEMORY_REVIEW_RUNTIME,
    workspaceId: '77777777-7777-4777-8777-777777777777', profileId: 'property', python: join(f.runtime, 'venv/bin/python') };
  const rootKey = Buffer.alloc(32, 41);
  const open = () => { const service = createHermesMemoryReviewService({ context: () => context, key: () => rootKey }); services.push(service); return service; };
  const service = open(), capability = service.proposalIntegration('fictional-interrupted-chat', () => true)!;
  const input = { requestId: 'fictional-interrupted-preference', payload: { action: 'add' as const, target: 'memory' as const, content: 'Fictional preference for weekly summaries.' } };
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
