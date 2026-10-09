import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { acquireRuntimeStateLease, pathInsideStateRoot, RESTORE_HOLD_FILE, RESTORE_HOLD_SETTING, runtimeStateRoot } from './runtime-state-lock.ts';
import { LedgerDatabase } from './database.ts';
import { fileSecretStore, updateRegistry } from './provisioning.ts';

const moduleUrl = new URL('./runtime-state-lock.ts', import.meta.url).href;
test('parallel file-backed SQLite clients retain shared leases; maintenance and standalone writers join the same barrier', () => {
  const root = mkdtempSync(join(tmpdir(), 'gateway-leases-')); try {
    const one = new LedgerDatabase(join(root, 'ledger.sqlite')), two = new LedgerDatabase(join(root, 'ledger.sqlite'));
    assert.throws(() => acquireRuntimeStateLease(root, 'maintenance'), /gateway_state_in_use/);
    one.close(); assert.throws(() => acquireRuntimeStateLease(root, 'maintenance'), /gateway_state_in_use/); two.close();
    const hold = acquireRuntimeStateLease(root, 'maintenance');
    try {
      assert.throws(() => new LedgerDatabase(join(root, 'ledger.sqlite')), /gateway_state_in_use/);
      assert.throws(() => updateRegistry(join(root, 'registry', 'connectors.json'), () => ({ devices: [] })), /gateway_state_in_use/);
      assert.throws(() => fileSecretStore(join(root, 'secrets')), /gateway_state_in_use/);
      const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `import {acquireRuntimeStateLease} from ${JSON.stringify(moduleUrl)}; acquireRuntimeStateLease(${JSON.stringify(root)});`], { env: process.env });
      assert.notEqual(result.status, 0); assert.match(result.stderr.toString(), /gateway_state_in_use/);
    } finally { hold.release(); }
    // Leases and roots use the physical spelling (macOS tmp is /var -> /private/var).
    assert.equal(runtimeStateRoot(join(root, 'registry')), realpathSync(root));
    const reopened = acquireRuntimeStateLease(root, 'maintenance'); assert.equal(reopened.root, realpathSync(root)); reopened.release();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('only a proved dead same-host owner can recover; this boot\'s own, an unknown or a foreign owner remains held', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gateway-dead-')); try {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `import {acquireRuntimeStateLease} from ${JSON.stringify(moduleUrl)}; acquireRuntimeStateLease(${JSON.stringify(root)}); console.log('ready'); setInterval(()=>{},1000);`], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    // A child that fails before its lease exits instead of hanging this test.
    const ready = await Promise.race([once(child.stdout!, 'data').then(() => true), once(child, 'exit').then(() => false)]);
    assert.ok(ready, 'the child exited before acquiring its lease');
    child.kill('SIGKILL'); await once(child, 'exit');
    const held = acquireRuntimeStateLease(root, 'maintenance'); held.release();
    const live = acquireRuntimeStateLease(root);
    assert.throws(() => acquireRuntimeStateLease(root, 'maintenance'), /gateway_state_in_use/);
    live.release();
    const directory = join(root, '.realbud-gateway-leases'), path = join(directory, `writer-${'a'.repeat(32)}`);
    for (const owner of [null, { version: 2, host: 'another-host', pid: process.pid, boot: 'b'.repeat(32), token: 'a'.repeat(32), kind: 'writer' }, { version: 1, host: 'another-host', pid: 99999999, token: 'a'.repeat(32), kind: 'writer' }]) {
      writeFileSync(path, JSON.stringify(owner), { mode: 0o600 }); assert.throws(() => acquireRuntimeStateLease(root, 'maintenance'), /gateway_state_(in_use|unknown_owner)/);
    }
    assert.ok(readdirSync(directory).includes(`writer-${'a'.repeat(32)}`));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('a lease an earlier process left under this same PID is reclaimed (container PID 1 after a restart)', () => {
  const root = mkdtempSync(join(tmpdir(), 'gateway-reboot-')); try {
    acquireRuntimeStateLease(root).release();
    const directory = join(root, '.realbud-gateway-leases');
    const stale = [
      { name: `writer-${'c'.repeat(32)}`, owner: { version: 2, host: hostname(), pid: process.pid, boot: 'b'.repeat(32), token: 'c'.repeat(32), kind: 'writer' } },
      { name: 'maintenance', owner: { version: 2, host: hostname(), pid: process.pid, boot: 'b'.repeat(32), token: 'd'.repeat(32), kind: 'maintenance' } },
      // Written before owner records named their boot: necessarily an earlier process.
      { name: `writer-${'e'.repeat(32)}`, owner: { version: 1, host: hostname(), pid: process.pid, token: 'e'.repeat(32), kind: 'writer' } },
    ];
    for (const { name, owner } of stale) {
      writeFileSync(join(directory, name), JSON.stringify(owner), { mode: 0o600 });
      const maintenance = acquireRuntimeStateLease(root, 'maintenance'); maintenance.release();
      assert.equal(existsSync(join(directory, name)), false, name);
    }
    writeFileSync(join(directory, 'gate'), JSON.stringify({ version: 2, host: hostname(), pid: process.pid, boot: 'f'.repeat(32), token: 'f'.repeat(32), kind: 'gate' }), { mode: 0o600 });
    const writer = acquireRuntimeStateLease(root);
    assert.deepEqual(readdirSync(directory).map(name => name.startsWith('writer-')), [true]);
    writer.release(); assert.deepEqual(readdirSync(directory), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('a worker thread shares the PID but not the boot identity, so it takes no lease', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gateway-worker-')); try {
    const worker = new Worker(`import(${JSON.stringify(moduleUrl)}).then(m => { try { m.acquireRuntimeStateLease(${JSON.stringify(root)}); require('node:worker_threads').parentPort.postMessage('acquired'); } catch (error) { require('node:worker_threads').parentPort.postMessage(error.message); } });`, { eval: true });
    const [message] = await once(worker, 'message'); await worker.terminate();
    assert.equal(message, 'gateway_state_worker_thread');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('a root reached through a host alias is admitted by its physical path; a linked root or inner link stays refused', () => {
  const base = mkdtempSync(join(tmpdir(), 'gateway-alias-')); try {
    mkdirSync(join(base, 'real')); symlinkSync(join(base, 'real'), join(base, 'alias'));
    const db = new LedgerDatabase(join(base, 'alias', 'state', 'ledger.sqlite'));
    const physical = join(realpathSync(base), 'real', 'state');
    try {
      assert.equal(db.stateRoot, physical);
      assert.equal(pathInsideStateRoot(join(base, 'alias', 'state', 'connectors.json'), physical), join(physical, 'connectors.json'));
      mkdirSync(join(physical, 'inner')); symlinkSync(join(physical, 'inner'), join(physical, 'linked'));
      assert.equal(pathInsideStateRoot(join(base, 'alias', 'state', 'linked', 'connectors.json'), physical), undefined);
      assert.equal(pathInsideStateRoot(join(base, 'elsewhere.json'), physical), undefined);
    } finally { db.close(); }
    symlinkSync(physical, join(base, 'linked-root'));
    assert.throws(() => acquireRuntimeStateLease(join(base, 'linked-root')), /gateway_state_permissions/);
    assert.throws(() => new LedgerDatabase(join(base, 'linked-root', 'ledger.sqlite')), /gateway_state_permissions/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
test('an owned state folder open to group/other (a Fly volume root) is tightened to 0700; a loose state file is not', () => {
  const root = mkdtempSync(join(tmpdir(), 'gateway-volume-')); const warn = console.warn; const warned: string[] = [];
  console.warn = (line: string) => { warned.push(line); };
  try {
    chmodSync(root, 0o755);
    const db = new LedgerDatabase(join(root, 'ledger.sqlite')); db.close();
    assert.equal(statSync(root).mode & 0o777, 0o700);
    assert.equal(warned.length, 1); assert.match(warned[0]!, /tightened_to_owner_only/);
    chmodSync(join(root, 'ledger.sqlite'), 0o644);
    assert.throws(() => new LedgerDatabase(join(root, 'ledger.sqlite')), /gateway_state_file_permissions/);
    assert.equal(statSync(join(root, 'ledger.sqlite')).mode & 0o777, 0o644);
  } finally { console.warn = warn; rmSync(root, { recursive: true, force: true }); }
});
test('an interrupted restore marker alone holds every writer before any state exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'gateway-progress-')); try {
    writeFileSync(join(root, RESTORE_HOLD_FILE), '{"state":"in-progress"}', { mode: 0o600 });
    assert.throws(() => new LedgerDatabase(join(root, 'ledger.sqlite')), /gateway_restored_state_held/);
    assert.throws(() => updateRegistry(join(root, 'connectors.json'), () => ({ devices: [] })), /gateway_restored_state_held/);
    const maintenance = acquireRuntimeStateLease(root, 'maintenance'); maintenance.release();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('file-backed admission refuses noncanonical ledger names before allocating or changing state', () => {
  const root = mkdtempSync(join(tmpdir(), 'gateway-ledger-name-')); try {
    for (const name of ['gateway.sqlite', 'gateway.db', 'Ledger.sqlite']) {
      const directory = join(root, name);
      assert.throws(() => new LedgerDatabase(join(directory, name)), /gateway_ledger_filename_required/);
      assert.equal(existsSync(directory), false);
    }
    const existing = join(root, 'gateway.sqlite'); writeFileSync(existing, 'preserved existing data', { mode: 0o600 });
    assert.throws(() => new LedgerDatabase(existing), /gateway_ledger_filename_required/);
    assert.equal(readFileSync(existing).toString(), 'preserved existing data');
    assert.deepEqual(readdirSync(root), ['gateway.sqlite']);
    const memory = new LedgerDatabase(':memory:'); memory.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('the persisted canonical DB hold alone refuses saved, fresh and child-process writers', () => {
  const root = mkdtempSync(join(tmpdir(), 'gateway-db-hold-')); try {
    const db = new LedgerDatabase(join(root, 'ledger.sqlite'));
    const secretDirectory = join(root, 'secrets'), registry = join(root, 'connectors.json');
    const savedStore = fileSecretStore(secretDirectory);
    updateRegistry(registry, () => ({ devices: [] }));
    const originalRegistry = readFileSync(registry);
    db.run('INSERT INTO settings(key,value) VALUES(?,?)', RESTORE_HOLD_SETTING, '{"state":"held"}'); db.close();
    assert.equal(existsSync(join(root, RESTORE_HOLD_FILE)), false);
    assert.throws(() => new LedgerDatabase(join(root, 'ledger.sqlite')), /gateway_restored_state_held/);
    assert.throws(() => savedStore.write('held-project', 'not-published'), /gateway_restored_state_held/);
    assert.throws(() => fileSecretStore(secretDirectory), /gateway_restored_state_held/);
    assert.throws(() => updateRegistry(registry, () => ({ devices: [] })), /gateway_restored_state_held/);
    assert.deepEqual(readFileSync(registry), originalRegistry);
    assert.equal(existsSync(secretDirectory), false);
    const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import {LedgerDatabase} from ${JSON.stringify(new URL('./database.ts', import.meta.url).href)};
      import {fileSecretStore,updateRegistry} from ${JSON.stringify(new URL('./provisioning.ts', import.meta.url).href)};
      assert.throws(()=>new LedgerDatabase(${JSON.stringify(join(root, 'ledger.sqlite'))}),/gateway_restored_state_held/);
      assert.throws(()=>fileSecretStore(${JSON.stringify(secretDirectory)}),/gateway_restored_state_held/);
      assert.throws(()=>updateRegistry(${JSON.stringify(registry)},()=>({devices:[]})),/gateway_restored_state_held/);
    `], { env: process.env, timeout: 5_000 });
    assert.equal(result.status, 0, result.stderr.toString());
    const maintenance = acquireRuntimeStateLease(root, 'maintenance'); maintenance.release();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('repeated vanished admission gates remain bounded without reclaiming any owner by age', () => {
  const root = mkdtempSync(join(tmpdir(), 'gateway-gate-churn-')); try {
    const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
      import assert from 'node:assert/strict'; import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
      let now=0, attempts=0; Date.now=()=>now;
      const realLink=fs.linkSync;
      fs.linkSync=(source,target)=>{ if(target.endsWith('/.realbud-gateway-leases/gate')) { attempts++; now+=600; throw Object.assign(new Error('synthetic vanished gate'),{code:'EEXIST'}); } return realLink(source,target); };
      syncBuiltinESMExports();
      const {acquireRuntimeStateLease}=await import(${JSON.stringify(moduleUrl)});
      assert.throws(()=>acquireRuntimeStateLease(${JSON.stringify(root)}),/gateway_state_in_use/);
      assert.equal(attempts,2);
      assert.deepEqual(fs.readdirSync(${JSON.stringify(join(root, '.realbud-gateway-leases'))}),[]);
    `], { env: process.env, timeout: 3_000 });
    assert.equal(result.status, 0, result.stderr.toString());
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('exact staged gate publications grant no lease, are preserved, and do not block shared admission', () => {
  const root = mkdtempSync(join(tmpdir(), 'gateway-gate-staged-')); try {
    const initial = acquireRuntimeStateLease(root); initial.release();
    const directory = join(root, '.realbud-gateway-leases'), staged = `gate.${'b'.repeat(32)}.tmp`;
    writeFileSync(join(directory, staged), 'unpublished bytes', { mode: 0o600 });
    const writer = acquireRuntimeStateLease(root);
    assert.throws(() => acquireRuntimeStateLease(root, 'maintenance'), /gateway_state_in_use/);
    writer.release();
    const maintenance = acquireRuntimeStateLease(root, 'maintenance');
    assert.throws(() => acquireRuntimeStateLease(root), /gateway_state_in_use/); maintenance.release();
    assert.equal(readFileSync(join(directory, staged)).toString(), 'unpublished bytes');
    writeFileSync(join(directory, 'gate.unbounded.tmp'), 'unknown owner', { mode: 0o600 });
    assert.throws(() => acquireRuntimeStateLease(root), /gateway_state_unknown_owner/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('a failed initial SQLite pragma releases the same-process runtime lease', () => {
  const root = mkdtempSync(join(tmpdir(), 'gateway-pragma-failure-')); try {
    const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
      import assert from 'node:assert/strict'; import {DatabaseSync} from 'node:sqlite';
      const actual=DatabaseSync.prototype.exec;
      DatabaseSync.prototype.exec=function(query){if(query==='PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;')throw new Error('synthetic_initial_pragma_failure');return actual.call(this,query);};
      const {LedgerDatabase}=await import(${JSON.stringify(new URL('./database.ts', import.meta.url).href)});
      const {acquireRuntimeStateLease}=await import(${JSON.stringify(moduleUrl)});
      assert.throws(()=>new LedgerDatabase(${JSON.stringify(join(root, 'ledger.sqlite'))}),/synthetic_initial_pragma_failure/);
      const maintenance=acquireRuntimeStateLease(${JSON.stringify(root)},'maintenance'); maintenance.release();
    `], { env: process.env, timeout: 5_000 });
    assert.equal(result.status, 0, result.stderr.toString());
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('readonly admission waits for a real SQLite exclusive commit and observes the newly persisted hold', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gateway-schema-contention-'));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const path = join(root, 'ledger.sqlite'), db = new LedgerDatabase(path); db.close();
    child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
      import {DatabaseSync} from 'node:sqlite';
      const db=new DatabaseSync(${JSON.stringify(path)});
      db.exec('PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;');
      db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run(${JSON.stringify(RESTORE_HOLD_SETTING)},'held-under-exclusive-commit');
      process.stdout.write('ready\\n');
      setTimeout(()=>{db.exec('COMMIT;');db.close();},200);
    `], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(child, 'exit'); let stderr = ''; child.stderr!.on('data', bytes => { stderr += bytes; });
    await once(child.stdout!, 'data');
    assert.throws(() => acquireRuntimeStateLease(root), /gateway_restored_state_held/);
    const [code] = await exited; assert.equal(code, 0, stderr);
    const maintenance = acquireRuntimeStateLease(root, 'maintenance'); maintenance.release();
  } finally { if (child?.exitCode === null) child.kill('SIGKILL'); rmSync(root, { recursive: true, force: true }); }
});
