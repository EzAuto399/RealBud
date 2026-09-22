import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { PrivateBackupPreparedStore } from './private-backup-prepared.ts';
import { stagePrivateRestoreV2, PRIVATE_RESTORE_V2_STAGE_FILE } from './private-backup-cold-restore.ts';
import { emptyV3 } from '../shared/desk-v3.ts';
import { encryptJson } from './desk-crypto.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures: string[] = [], children: { child: ChildProcess; closed: Promise<void> }[] = [];
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function stop(owned: (typeof children)[number]) {
  if (owned.child.exitCode === null && !owned.child.signalCode) owned.child.kill('SIGTERM');
  await Promise.race([owned.closed, delay(3000)]);
  if (owned.child.exitCode === null && !owned.child.signalCode) { owned.child.kill('SIGKILL'); await owned.closed; }
  expect(owned.child.exitCode !== null || owned.child.signalCode !== null).toBe(true);
}
afterEach(async () => { for (const child of children.splice(0)) await stop(child); for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true }); });

async function fixture() {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'RealBud v2 boot Ω ')); fixtures.push(directory);
  const key = randomBytes(32), workspaceId = randomUUID(), directoryId = randomUUID();
  mkdirSync(join(directory, 'company-installation'), { mode: 0o700 });
  const identity = JSON.stringify({ version: 1, id: workspaceId, workerMemberKey: null });
  writeFileSync(join(directory, 'company-installation/workspace.json'), identity, { mode: 0o600 });
  writeFileSync(join(directory, 'desk.key'), key, { mode: 0o600 });
  writeFileSync(join(directory, 'config.json'), JSON.stringify({ instances: { fixture: { driver: 'not-a-real-driver' } } }), { mode: 0o600 });
  const book = emptyV3({ name: 'Fictional bootstrap agency', timezone: 'UTC', jurisdictions: [] }); book.revision = 2; book.hands = 'held';
  const preparedParent = join(directory, 'private-backup-v2', 'prepared'); mkdirSync(preparedParent, { recursive: true, mode: 0o700 });
  const store = await PrivateBackupPreparedStore.create({ directory: join(preparedParent, directoryId), key, workspaceId });
  let summary;
  try {
    for (const [path, bytes, before] of [
      ['company-installation/workspace.json', Buffer.from(identity), sha(identity)],
      ['desk.json', Buffer.from(JSON.stringify(encryptJson(key, book))), null],
      ['vault/workflow-inputs/original.csv', Buffer.from('\uFEFFDate,Reference\r\n2026-09-21,00012\r\n'), null],
    ] as const) await store.addFile(path, before, (async function* () { yield bytes; })());
    summary = await store.seal();
  } finally { await store.close(); }
  const receipt = { digest: sha('fictional archive'), createdAt: '2026-09-21T00:00:00.000Z', workspaceId, fileCount: 3, recordCount: 0, plainBytes: 100, included: ['Private fixture'], excluded: ['Credentials'], restoreChanges: ['Review work'] };
  await stagePrivateRestoreV2({ directory, key, workspaceId, directoryId, storeId: summary.storeId, expectedPreparedDigest: summary.digest, receipt, assertFresh() {}, assertIdle() {}, epoch: () => 'held-fixture' });
  return { directory, key, receipt };
}
async function start(directory: string) {
  const socket = createServer(); await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = (socket.address() as { port: number }).port; await new Promise<void>(resolve => socket.close(() => resolve()));
  const envModule: string = '../scripts/service-smoke-env.mjs'; const { serviceSmokeEnv } = await import(envModule);
  const child = spawn(process.execPath, [join(root, 'server/bootstrap.ts')], { cwd: root,
    env: { ...serviceSmokeEnv({ executable: process.execPath, home: directory, data: directory, scratch: directory, port }), REALBUD_MANAGED_SERVICE: '0', REALBUD_SERVICE_ENTITLEMENT_REQUIRED: '0', VITEST: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; for (const stream of [child.stdout, child.stderr]) stream?.on('data', data => { logs = (logs + data).slice(-12_000); });
  const closed = new Promise<void>((resolve, reject) => { child.once('close', () => resolve()); child.once('error', reject); });
  const owned = { child, closed }; children.push(owned);
  return { owned, base: `http://127.0.0.1:${port}`, logs: () => logs };
}

describe('real service bootstrap for prepared v2 restoration', () => {
  it('applies before stores load and exposes the persisted completion receipt through actual HTTP', async () => {
    const f = await fixture(), server = await start(f.directory); let ready = false;
    for (let i = 0; i < 100; i++) {
      if (server.owned.child.exitCode !== null || server.owned.child.signalCode) break;
      try { const response = await fetch(`${server.base}/api/health`, { signal: AbortSignal.timeout(300) }); const health = await response.json() as { pid: number }; if (health.pid === server.owned.child.pid) { ready = true; break; } } catch {}
      await delay(100);
    }
    expect(ready, server.logs()).toBe(true);
    const session = await (await fetch(`${server.base}/api/session`)).json() as { token: string };
    const status = await (await fetch(`${server.base}/api/private-backup`, { headers: { 'x-realbud-session': session.token } })).json() as any;
    expect(status.completed.receipt).toEqual(f.receipt); expect(status.staged).toBe(false);
    expect(readFileSync(join(f.directory, 'desk.key'))).toEqual(f.key);
    expect(readFileSync(join(f.directory, 'vault/workflow-inputs/original.csv'), 'utf8')).toBe('\uFEFFDate,Reference\r\n2026-09-21,00012\r\n');
    expect(existsSync(join(f.directory, PRIVATE_RESTORE_V2_STAGE_FILE))).toBe(false);
    // Exercise the real export route, admission middleware and status route.
    // Scrypt/file capture provides an actual pause, without a test-only endpoint.
    writeFileSync(join(f.directory, 'vault/workflow-inputs/pause.txt'), Buffer.alloc(4 * 1024 * 1024, 70), { mode: 0o600 });
    const beforeBook = readFileSync(join(f.directory, 'desk.json'));
    let finished = false;
    const exporting = fetch(`${server.base}/api/private-backup/export`, { method: 'POST', signal: AbortSignal.timeout(10_000), headers: { 'x-realbud-session': session.token, 'content-type': 'application/json' }, body: JSON.stringify({ passphrase: 'Fictional pause export passphrase' }) })
      .then(async response => ({ status: response.status, body: await response.json() as any })).finally(() => { finished = true; });
    try {
      let paused = false;
      for (let i = 0; i < 100 && !finished; i++) {
        const current = await (await fetch(`${server.base}/api/private-backup`, { headers: { 'x-realbud-session': session.token } })).json() as any;
        if (current.snapshotActive) { paused = true; break; } await delay(2);
      }
      expect(paused).toBe(true);
      for (const path of ['/api/desk', '/api/bots/bud/messages']) {
        const response = await fetch(server.base + path, { method: path.endsWith('/messages') ? 'POST' : 'GET', headers: { 'x-realbud-session': session.token, 'content-type': 'application/json' } });
        expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: 'private_snapshot_active' });
      }
      const health = await fetch(`${server.base}/api/health`); expect(health.status).toBe(200);
    } finally { await exporting; }
    const exported = await exporting; expect(exported.status).toBe(200); expect(exported.body.backup.version).toBe(1);
    const resumed = await fetch(`${server.base}/api/desk`, { headers: { 'x-realbud-session': session.token } }); expect(resumed.status).toBe(200);
    expect(readFileSync(join(f.directory, 'desk.json'))).toEqual(beforeBook);
    await stop(server.owned);
  }, 20_000);
  it.each(['conflicting stage', 'changed target', 'wrong key'])('holds startup before opening application stores: %s', async attack => {
    const f = await fixture();
    if (attack === 'conflicting stage') writeFileSync(join(f.directory, 'private-workspace-restore.json'), 'fictional conflicting stage');
    if (attack === 'changed target') writeFileSync(join(f.directory, 'desk.json'), 'fictional changed target');
    if (attack === 'wrong key') writeFileSync(join(f.directory, 'desk.key'), randomBytes(32));
    const stage = readFileSync(join(f.directory, PRIVATE_RESTORE_V2_STAGE_FILE)), server = await start(f.directory);
    await Promise.race([server.owned.closed, delay(10_000)]);
    expect(server.owned.child.exitCode, server.logs()).toBe(1);
    expect(readFileSync(join(f.directory, PRIVATE_RESTORE_V2_STAGE_FILE))).toEqual(stage);
    expect(existsSync(join(f.directory, 'workflow-state.sqlite'))).toBe(false);
  }, 15_000);
});
