import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { emptyV3 } from '../shared/desk-v3.ts';
import { encryptJson } from './desk-crypto.ts';
import { createPrivateWorkspaceBackup } from './private-workspace-backup.ts';
import { PrivateBackupPreparedStore } from './private-backup-prepared.ts';
import { stagePrivateRestoreV2 } from './private-backup-cold-restore.ts';
import { plantPrivateFile, privateDir, privateTempRoot } from './testing/private-fixture.ts';

const bootstrapUrl = new URL('./bootstrap.ts', import.meta.url).href, indexUrl = new URL('./index.ts', import.meta.url).href;
const operationsUrl = new URL('./connected-app-operations.ts', import.meta.url).href, cryptoUrl = new URL('./desk-crypto.ts', import.meta.url).href;
const roots: string[] = [], sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
// This no-child-process boundary proof is POSIX-only: real Windows admission
// needs its fixed PowerShell ACL helper. Native Windows bootstrap proof remains
// a separate gate; this fixture must neither bypass ACLs nor block that helper
// and then misreport a product failure.
const guardedIt = it.skipIf(process.platform === 'win32');
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(legacy = '.openmausbot') {
  const root = privateTempRoot(join(tmpdir(), 'bootstrap-startup-')); roots.push(root);
  const home = join(root, 'home'), temp = join(root, 'tmp'); privateDir(home); privateDir(temp);
  return { root, home, temp, legacy: join(home, legacy), data: join(home, '.realbud') };
}
/** Actual bootstrap/index static graph, stopped before seedVault, worker or
 * profile startup, timers and listen. The test loader inserts only that stop. */
function run(f: ReturnType<typeof fixture>, check: string, expected = 'AUDIT_STOP_AFTER_ENSURE') {
  const env: NodeJS.ProcessEnv = { PATH: dirname(process.execPath) + (process.platform === 'win32' ? ';' : ':') + (process.env.PATH ?? ''),
    HOME: f.home, USERPROFILE: f.home, TMPDIR: f.temp, TMP: f.temp, TEMP: f.temp, LANG: 'C.UTF-8' };
  for (const name of ['SystemRoot', 'SystemDrive', 'windir']) if (process.env[name]) env[name] = process.env[name];
  const code = [
    "import assert from 'node:assert/strict';import fs from 'node:fs';import {createHash} from 'node:crypto';import http from 'node:http';import https from 'node:https';import net from 'node:net';import tls from 'node:tls';import cp from 'node:child_process';import {registerHooks,syncBuiltinESMExports} from 'node:module';",
    "const forbidden=[];const deny=kind=>(..._args)=>{forbidden.push(kind);throw new Error('Forbidden startup test effect: '+kind);};",
    "globalThis.fetch=deny('fetch');http.request=deny('http');http.get=deny('http-get');https.request=deny('https');https.get=deny('https-get');net.connect=deny('net');net.createConnection=deny('net-create');tls.connect=deny('tls');",
    "cp.spawn=deny('spawn');cp.spawnSync=deny('spawnSync');cp.exec=deny('exec');cp.execSync=deny('execSync');cp.execFile=deny('execFile');cp.execFileSync=deny('execFileSync');cp.fork=deny('fork');syncBuiltinESMExports();",
    "const data=" + JSON.stringify(f.data) + ",legacy=" + JSON.stringify(f.legacy) + ",index=" + JSON.stringify(indexUrl) + ",hash=path=>createHash('sha256').update(fs.readFileSync(path)).digest('hex');let indexImported=false;",
    "registerHooks({load(url,context,next){const value=next(url,context);if(url!==index)return value;indexImported=true;const source=String(value.source),needle='\\nensureDirs();\\nseedVault();';assert.ok(source.includes(needle));return {...value,source:source.replace(needle,'\\nensureDirs(); throw new Error(\"AUDIT_STOP_AFTER_ENSURE\");\\nseedVault();')};}});",
    "await assert.rejects(import(" + JSON.stringify(bootstrapUrl) + "),new RegExp(" + JSON.stringify(expected) + "));assert.deepEqual(forbidden,[]);",
    check,
  ].join('\n');
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code],
    { env, encoding: 'utf8', timeout: process.platform === 'win32' ? 120_000 : 15_000 });
  expect(result.status, result.stderr).toBe(0);
}
for (const name of ['.openmausbot', '.opengrokbot']) {
  guardedIt('actual bootstrap migrates ' + name + ' before static stores allocate DATA_DIR', () => {
    const f = fixture(name), identity = JSON.stringify({ version: 1, id: randomUUID(), workerMemberKey: null });
    plantPrivateFile(join(f.legacy, 'company-installation/workspace.json'), identity);
    plantPrivateFile(join(f.legacy, 'connected-app-operations.json'), '{"version":1,"operations":[]}');
    run(f, "assert.equal(indexImported,true);assert.equal(fs.existsSync(legacy),false);assert.equal(fs.readFileSync(data+'/company-installation/workspace.json','utf8')," + JSON.stringify(identity) + ");assert.equal(fs.readFileSync(data+'/connected-app-operations.json','utf8'),'{\"version\":1,\"operations\":[]}');");
  });
}
guardedIt('actual bootstrap tightens owned0755 before static history admission', () => {
  const f = fixture('.realbud'); plantPrivateFile(join(f.data, 'connected-app-operations.json'), '{"version":1,"operations":[]}'); chmodSync(f.data, 0o755);
  run(f, "assert.equal(indexImported,true);assert.equal(fs.statSync(data).mode&0o777,0o700);const {connectedAppOperations:store}=await import(" + JSON.stringify(operationsUrl) + ");assert.deepEqual(store.list(),[]);store.deny({threadId:'synthetic-thread',toolName:'GMAIL_SEND_EMAIL',toolSlugs:[]});");
});
for (const version of [1, 2] as const) {
  guardedIt('actual bootstrap applies legacy-folder v' + version + ' staged restore before index stores', async () => {
    const f = fixture(version === 1 ? '.openmausbot' : '.opengrokbot'), key = randomBytes(32), workspaceId = randomUUID();
    const identity = JSON.stringify({ version: 1, id: workspaceId, workerMemberKey: null });
    plantPrivateFile(join(f.legacy, 'desk.key'), key); plantPrivateFile(join(f.legacy, 'company-installation/workspace.json'), identity);
    const book = emptyV3({ name: 'Synthetic bootstrap agency', timezone: 'UTC', jurisdictions: [] }); book.revision = 2; book.hands = 'held';
    if (version === 1) {
      const source = join(f.root, 'source'), sourceKey = randomBytes(32); privateDir(source);
      plantPrivateFile(join(source, 'company-installation/workspace.json'), identity); plantPrivateFile(join(source, 'desk.json'), JSON.stringify(encryptJson(sourceKey, book)));
      const opts = { key: () => sourceKey, workspaceId, epoch: () => 'fixture', assertIdle() {}, assertFresh() {} };
      const exported = await createPrivateWorkspaceBackup({ ...opts, directory: source }).exportBackup('Synthetic bootstrap fixture passphrase');
      await createPrivateWorkspaceBackup({ ...opts, key: () => key, directory: f.legacy }).stageRestore({ backup: exported.backup, passphrase: 'Synthetic bootstrap fixture passphrase', expectedDigest: exported.receipt.digest });
    } else {
      const directoryId = randomUUID(), parent = join(f.legacy, 'private-backup-v2', 'prepared'); privateDir(parent);
      const store = await PrivateBackupPreparedStore.create({ directory: join(parent, directoryId), key, workspaceId }); let summary;
      try {
        for (const [path, bytes, before] of [['company-installation/workspace.json', Buffer.from(identity), sha(identity)], ['desk.json', Buffer.from(JSON.stringify(encryptJson(key, book))), null]] as const)
          await store.addFile(path, before, (async function* () { yield bytes; })());
        summary = await store.seal();
      } finally { await store.close(); }
      const receipt = { digest: sha('synthetic archive'), createdAt: '2026-10-09T00:00:00.000Z', workspaceId, fileCount: 2, recordCount: 0, plainBytes: 100, included: ['Private fixture'], excluded: ['Credentials'], restoreChanges: ['Review work'] };
      await stagePrivateRestoreV2({ directory: f.legacy, key, workspaceId, directoryId, storeId: summary.storeId, expectedPreparedDigest: summary.digest, receipt, assertFresh() {}, assertIdle() {}, epoch: () => 'fixture' });
    }
    const keyDigest = sha(readFileSync(join(f.legacy, 'desk.key')));
    run(f, "assert.equal(indexImported,true);assert.equal(fs.existsSync(legacy),false);assert.equal(hash(data+'/desk.key')," + JSON.stringify(keyDigest) + ");assert.equal(fs.readFileSync(data+'/company-installation/workspace.json','utf8')," + JSON.stringify(identity) + ");assert.equal(fs.existsSync(data+'/private-workspace-restore" + (version === 2 ? '-v2' : '') + ".json'),false);const {decryptJson}=await import(" + JSON.stringify(cryptoUrl) + ");const book=decryptJson(fs.readFileSync(data+'/desk.key'),JSON.parse(fs.readFileSync(data+'/desk.json','utf8')));assert.equal(book.revision," + (version === 1 ? 3 : 2) + ");assert.equal(book.hands,'held');assert.equal(book.agency.name,'Synthetic bootstrap agency');");
  });
}
guardedIt('actual bootstrap holds conflicting legacy stages before index stores and preserves original key and stages', () => {
  const f = fixture(); plantPrivateFile(join(f.legacy, 'desk.key'), randomBytes(32));
  for (const name of ['private-workspace-restore.json', 'private-workspace-restore-v2.json']) plantPrivateFile(join(f.legacy, name), 'synthetic unchanged stage');
  const before = sha(readFileSync(join(f.legacy, 'desk.key')));
  run(f, "assert.equal(indexImported,false);assert.equal(fs.existsSync(legacy),false);assert.equal(hash(data+'/desk.key')," + JSON.stringify(before) + ");for(const name of ['private-workspace-restore.json','private-workspace-restore-v2.json'])assert.equal(fs.readFileSync(data+'/'+name,'utf8'),'synthetic unchanged stage');assert.equal(fs.existsSync(data+'/workflow-state.sqlite'),false);", 'Conflicting private restores');
});
guardedIt('actual bootstrap refuses a linked original restore key before application stores and keeps retained stage bytes', () => {
  const f = fixture(); plantPrivateFile(join(f.legacy, 'synthetic-original-key'), randomBytes(32));
  symlinkSync('synthetic-original-key', join(f.legacy, 'desk.key'));
  plantPrivateFile(join(f.legacy, 'private-workspace-restore.json'), 'synthetic retained stage');
  const before = sha(readFileSync(join(f.legacy, 'synthetic-original-key')));
  run(f, "assert.equal(indexImported,false);assert.equal(fs.existsSync(legacy),false);assert.equal(fs.readFileSync(data+'/private-workspace-restore.json','utf8'),'synthetic retained stage');assert.equal(hash(data+'/synthetic-original-key')," + JSON.stringify(before) + ");assert.equal(fs.lstatSync(data+'/desk.key').isSymbolicLink(),true);assert.equal(fs.existsSync(data+'/workflow-state.sqlite'),false);", 'The staged restore key needs recovery');
});
