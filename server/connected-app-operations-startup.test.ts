import { createHash } from 'node:crypto';
import { chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { plantPrivateFile, privateDir, privateTempRoot, windowsAdmissionTimeout } from './testing/private-fixture.ts';

const operationsUrl = new URL('./connected-app-operations.ts', import.meta.url).href;
const configUrl = new URL('./config.ts', import.meta.url).href;
const roots: string[] = [];
const id = '00000000-0000-4000-8000-000000000001';
const workspaceDigest = createHash('sha256').update(id).digest('hex');
const row = { id: '11111111-1111-4111-8111-111111111111', threadId: 'synthetic-thread', toolName: 'GMAIL_SEND_EMAIL', toolSlugs: [],
  status: 'unknown', startedAt: 1, finishedAt: 2, revision: 1, detail: 'The app outcome is unknown. Check the app before trying this action again; RealBud has not replayed it.',
  accountDigest: 'a'.repeat(64), realmDigest: 'f'.repeat(64), bindingDigest: 'b'.repeat(64), effectDigest: 'c'.repeat(64), reviewDigest: 'd'.repeat(64), workspaceDigest };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(legacy?: string) {
  const root = privateTempRoot(join(tmpdir(), 'app-operation-startup-')); roots.push(root);
  const home = join(root, 'home'), temp = join(root, 'tmp'); privateDir(home); privateDir(temp);
  const data = join(home, '.realbud'), saved = legacy ? join(home, legacy) : data;
  return { root, home, temp, data, saved, file: join(saved, 'connected-app-operations.json') };
}
function plant(f: ReturnType<typeof fixture>, receipt: unknown = row) {
  plantPrivateFile(f.file, JSON.stringify({ version: 1, operations: [receipt] }));
  plantPrivateFile(join(f.saved, 'company-installation', 'workspace.json'), JSON.stringify({ version: 1, id, workerMemberKey: null }));
}
function run(f: ReturnType<typeof fixture>, program: string) {
  const env: NodeJS.ProcessEnv = { PATH: `${dirname(process.execPath)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
    HOME: f.home, USERPROFILE: f.home, TMPDIR: f.temp, TMP: f.temp, TEMP: f.temp, LANG: 'C.UTF-8' };
  for (const name of ['SystemRoot', 'SystemDrive', 'windir']) if (process.env[name]) env[name] = process.env[name];
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
    import assert from 'node:assert/strict'; import fs from 'node:fs'; import {createHash} from 'node:crypto'; import {syncBuiltinESMExports} from 'node:module';
    const data=${JSON.stringify(f.data)},file=data+'/connected-app-operations.json';
    const hash=path=>createHash('sha256').update(fs.readFileSync(path)).digest('hex');
    const opUrl=${JSON.stringify(operationsUrl)},configUrl=${JSON.stringify(configUrl)};
    ${program}
  `], { env, encoding: 'utf8', timeout: process.platform === 'win32' ? 120_000 : 15_000 });
  expect(result.status, result.stderr).toBe(0);
}
it('actual default-store import leaves absent DATA_DIR untouched until startup and first authoritative use', windowsAdmissionTimeout(30), () => {
  const f = fixture();
  run(f, `const {connectedAppOperations:store}=await import(opUrl);assert.equal(fs.existsSync(data),false);
    const {ensureDirs}=await import(configUrl);ensureDirs();assert.equal(fs.existsSync(file),false);
    store.deny({threadId:'synthetic-thread',toolName:'GMAIL_SEND_EMAIL',toolSlugs:[]});assert.equal(store.list()[0].status,'denied');`);
});
for (const legacy of ['.openmausbot', '.opengrokbot']) {
  it(`default-store import preserves ${legacy} migration bytes and persisted workspace identity`, windowsAdmissionTimeout(40), () => {
    const f = fixture(legacy); plant(f);
    run(f, `const legacy=${JSON.stringify(f.saved)},before=hash(legacy+'/connected-app-operations.json'),identity=hash(legacy+'/company-installation/workspace.json');
      const {connectedAppOperations:store}=await import(opUrl);assert.equal(fs.existsSync(data),false);
      const {ensureDirs}=await import(configUrl);ensureDirs();assert.equal(fs.existsSync(legacy),false);
      assert.equal(hash(file),before);assert.equal(hash(data+'/company-installation/workspace.json'),identity);
      assert.equal(store.workspaceDigest,${JSON.stringify(workspaceDigest)});assert.equal(store.list()[0].status,'unknown');assert.equal(hash(file),before);
      assert.throws(()=>store.priorMailEffect('c'.repeat(64),'f'.repeat(64)),/unresolved outcome/);`);
  });
}
it.skipIf(process.platform === 'win32')('owned0755 admission happens after ensureDirs tightens the folder without latching a false recovery hold', () => {
  const f = fixture(); plant(f); chmodSync(f.data, 0o755);
  run(f, `const before=hash(file);const {connectedAppOperations:store}=await import(opUrl);assert.equal(fs.statSync(data).mode&0o777,0o755);
    const {ensureDirs}=await import(configUrl);ensureDirs();assert.equal(fs.statSync(data).mode&0o777,0o700);
    assert.equal(store.list().length,1);assert.equal(store.workspaceDigest,${JSON.stringify(workspaceDigest)});assert.equal(hash(file),before);`);
});
it('first mutation recovers an unfinished receipt once before admitting new work and never replays it', windowsAdmissionTimeout(40), () => {
  const f = fixture(); const { finishedAt: _finishedAt, ...unfinished } = row;
  plant(f, { ...unfinished, status: 'started', revision: 0, detail: 'The app operation was recorded before dispatch. Its outcome is not yet confirmed.' });
  run(f, `const before=hash(file);const {connectedAppOperations:store}=await import(opUrl);assert.equal(hash(file),before);
    const {ensureDirs}=await import(configUrl);ensureDirs();const denied=store.deny({threadId:'other-thread',toolName:'GMAIL_SEND_EMAIL',toolSlugs:[]});
    const recovered=store.list().find(row=>row.id===${JSON.stringify(row.id)});assert.equal(recovered.status,'unknown');assert.equal(recovered.revision,1);assert.ok(recovered.finishedAt<=denied.startedAt);
    const committed=hash(file);store.list();void store.workspaceDigest;assert.equal(hash(file),committed);
    assert.throws(()=>store.priorMailEffect('c'.repeat(64),'f'.repeat(64)),/unresolved outcome/);`);
});
it('reconciliation as the first operation initializes retained identity and evidence before its CAS', windowsAdmissionTimeout(40), () => {
  const f = fixture(); plant(f);
  run(f, `const {connectedAppOperations:store}=await import(opUrl);const {ensureDirs}=await import(configUrl);ensureDirs();
    const binding={accountDigest:'a'.repeat(64),realmDigest:'f'.repeat(64),originalBindingDigest:'b'.repeat(64),recoveryBindingDigest:'e'.repeat(64),workspaceDigest:${JSON.stringify(workspaceDigest)}};
    const saved=store.reconcile(${JSON.stringify(row.id)},1,'not-sent',binding);assert.equal(saved.status,'unknown');assert.equal(saved.revision,2);assert.equal(saved.reconciliation.source,'manual-app-inspection');`);
});
it('reclaims a crash lock from an exited process at startup, then turns the interrupted send into unknown without replay', windowsAdmissionTimeout(40), () => {
  const f = fixture(); const { finishedAt: _finishedAt, ...unfinished } = row;
  plant(f, { ...unfinished, status: 'started', revision: 0, detail: 'The app operation was recorded before dispatch. Its outcome is not yet confirmed.' });
  const exited = spawnSync(process.execPath, ['-e', '']).pid;
  plantPrivateFile(f.file + '.lock', JSON.stringify({ version: 1, pid: exited, bootUptime: 0 }));
  run(f, `const {connectedAppOperations:store}=await import(opUrl);const {ensureDirs}=await import(configUrl);ensureDirs();
    const recovered=store.list()[0];assert.equal(recovered.status,'unknown');assert.equal(recovered.revision,1);assert.equal(fs.existsSync(file+'.lock'),false);
    assert.throws(()=>store.priorMailEffect('c'.repeat(64),'f'.repeat(64)),/unresolved outcome/);`);
});
for (const unsafe of ['corrupt', 'symlink', 'hardlink'] as const) {
  it(`default ${unsafe} initialization remains permanently held after fixture repair without changing original evidence`, windowsAdmissionTimeout(40), () => {
    const f = fixture(); plant(f);
    run(f, `const original=fs.readFileSync(file),target=data+'/synthetic-linked-target';
      const kind=${JSON.stringify(unsafe)};
      if(kind==='corrupt')fs.writeFileSync(file,'broken json');
      if(kind==='symlink'||kind==='hardlink'){fs.renameSync(file,target);kind==='symlink'?fs.symlinkSync(target,file):fs.linkSync(target,file);}
      const before=fs.readFileSync(kind==='symlink'||kind==='hardlink'?target:file);
      const {connectedAppOperations:store}=await import(opUrl);const {ensureDirs}=await import(configUrl);ensureDirs();
      assert.throws(()=>store.list(),/history needs recovery/);assert.deepEqual(fs.readFileSync(kind==='symlink'||kind==='hardlink'?target:file),before);
      if(kind==='symlink'||kind==='hardlink')fs.unlinkSync(file);
      fs.writeFileSync(file,original,{mode:0o600});assert.throws(()=>store.list(),/history needs recovery/);
      assert.throws(()=>store.deny({threadId:'synthetic-thread',toolName:'GMAIL_SEND_EMAIL',toolSlugs:[]}),/history needs recovery/);assert.deepEqual(fs.readFileSync(file),original);`);
  });
}
it.skipIf(process.platform === 'win32')('wrong-owner directory admission stays held after the injected owner observation changes', () => {
  const f = fixture(); plant(f);
  run(f, `const {ensureDirs}=await import(configUrl);ensureDirs();const actual=fs.lstatSync;
    fs.lstatSync=(path,...args)=>{const stat=actual(path,...args);if(String(path)===data)Object.defineProperty(stat,'uid',{value:process.getuid()+1});return stat;};syncBuiltinESMExports();
    const {connectedAppOperations:store}=await import(opUrl);assert.throws(()=>store.list(),/history needs recovery/);
    fs.lstatSync=actual;syncBuiltinESMExports();assert.throws(()=>store.list(),/history needs recovery/);`);
});
