import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { careTermsDraft, fixture } from './testing.ts';
import { canonical } from './contracts.ts';
import { BillingService } from './billing.ts';
import { recordManualPayment } from './operator-billing.ts';
import { createGatewayRecoveryKey, exportGatewayBackup, restoreGatewayBackup, verifyGatewayBackup } from './gateway-backup.ts';
import { acquireRuntimeStateLease, RESTORE_HOLD_FILE, RESTORE_HOLD_SETTING, stateIdentity } from './runtime-state-lock.ts';
import { fileSecretStore, updateRegistry } from './provisioning.ts';
import { LedgerDatabase } from './database.ts';
import { composeGateway } from './composition.ts';

function setup() {
  const outer = mkdtempSync(join(tmpdir(), 'gateway-backup-')), root = join(outer, 'state');
  const f = fixture(join(root, 'ledger.sqlite'));
  const registry = join(root, 'connectors.json'), secrets = join(root, 'secrets');
  updateRegistry(registry, () => ({ devices: [] })); const store = fileSecretStore(secrets);
  store.write('REALBUD_COMPOSIO_PROJECT_FICTIONAL', 'ak_fictional_only'); store.write('REALBUD_COMPOSIO_WEBHOOK_FICTIONAL', 'fictional_webhook_only');
  f.setTime(Date.parse('2026-10-01T00:00:00Z'));
  const billing = new BillingService(f.ledger, undefined, { internalCompanyId: 'realbud-internal' });
  const terms = billing.commercialTerms!.publish(careTermsDraft(f, 'care-backup-v1', '12500'));
  billing.commercialTerms!.accept(f.owner, '2026-09', 'care-backup-v1', terms.digest);
  const invoice = billing.finalizeCommercialInvoice(f.tenant.companyId, '2026-09', 'care-backup-v1');
  recordManualPayment(billing, { subject: 'operator-fixture', role: 'realbud_operator' }, invoice.id, { paymentId: '11111111-1111-4111-8111-111111111111', method: 'bank_transfer', amountCents: '5000', receivedOn: '2026-10-01' });
  f.db.run('INSERT INTO checkouts(invoice,state,body) VALUES(?,?,?)', invoice.id, 'unknown', '{"fictionalPendingCheckout":true}');
  f.db.run('INSERT INTO invoice_email_outbox(invoice,tenant,state,body) VALUES(?,?,?,?)', invoice.id, f.tenant.companyId, 'unknown', '{"fictionalPendingEmail":true}');
  const original = f.ledger.db.all('SELECT * FROM events ORDER BY seq'), tenants = f.ledger.db.all('SELECT * FROM tenants');
  const financial = Object.fromEntries(['invoices', 'payments', 'checkouts', 'invoice_email_outbox'].map(table => [table, f.db.all(`SELECT * FROM ${table}`)]));
  const keyFile = join(outer, 'recovery', 'key'), output = join(outer, 'exports', 'archive.json'); createGatewayRecoveryKey(keyFile);
  f.close();
  return { outer, root, registry, secrets, keyFile, output, original, tenants, financial, config: { directory: root, registry, secrets, keyFile, output, sourceRevision: 'c'.repeat(40) }, close: () => rmSync(outer, { recursive: true, force: true }) };
}
/** Owner-key-authenticated bad manifests exercise admission after AEAD succeeds;
 * these are not provider state and never leave disposable fixture roots. */
function rewriteManifest(s: ReturnType<typeof setup>, change: (manifest: any) => void): void {
  const envelope = JSON.parse(readFileSync(s.output, 'utf8')), key = readFileSync(s.keyFile);
  const metadata = { version: 1, algorithm: 'aes-256-gcm', archiveId: envelope.archiveId };
  const read = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'base64')); read.setAAD(Buffer.from(canonical(metadata))); read.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const manifest = JSON.parse(Buffer.concat([read.update(Buffer.from(envelope.ciphertext, 'base64')), read.final()]).toString()); change(manifest);
  const nonce = randomBytes(12), write = createCipheriv('aes-256-gcm', key, nonce); write.setAAD(Buffer.from(canonical(metadata)));
  const ciphertext = Buffer.concat([write.update(Buffer.from(canonical(manifest))), write.final()]);
  writeFileSync(s.output, JSON.stringify({ ...metadata, nonce: nonce.toString('base64'), tag: write.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') })); key.fill(0);
}
/** Only the supported required recovery structure; this does not model every
 * historical business table or claim historic runtime migration coverage. */
function rewriteRequiredSchema(s: ReturnType<typeof setup>, version: number, missing?: 'settings' | 'events-columns'): void {
  const path = join(s.outer, `required-schema-${version}-${missing ?? 'valid'}.sqlite`);
  writeFileSync(path, Buffer.alloc(0), { mode: 0o600 }); const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA application_id=1380075351; PRAGMA user_version=${version};`);
    if (missing !== 'settings') db.exec('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);');
    db.exec(missing === 'events-columns' ? 'CREATE TABLE events(seq INTEGER PRIMARY KEY);' :
      'CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,tenant TEXT NOT NULL,kind TEXT NOT NULL,request TEXT,at INTEGER NOT NULL,body TEXT NOT NULL,previous TEXT NOT NULL,hash TEXT NOT NULL);');
  } finally { db.close(); }
  const bytes = readFileSync(path);
  rewriteManifest(s, value => {
    const row = value.files.find((entry: { path: string }) => entry.path === 'ledger.sqlite');
    row.bytes = bytes.length; row.sha256 = createHash('sha256').update(bytes).digest('hex'); row.data = bytes.toString('base64');
    value.schemaVersion = version; value.chainHead = 'genesis';
  });
}
test('encrypted offline roundtrip retains the ledger chain, exact registry and synthetic secrets, with permanent runtime and writer hold', async () => {
  const s = setup(); try {
    const receipt = await exportGatewayBackup(s.config), bytes = readFileSync(s.output, 'utf8');
    for (const plain of ['Fictional Agency', 'ak_fictional_only', 'fictional_webhook_only', 'REALBUD_COMPOSIO_PROJECT_FICTIONAL']) assert.equal(bytes.includes(plain), false);
    assert.equal(verifyGatewayBackup({ archive: s.output, keyFile: s.keyFile, scratchDirectory: join(s.outer, 'verify') }).sha256, receipt.sha256);
    const target = join(s.outer, 'target'); assert.equal(restoreGatewayBackup({ archive: s.output, keyFile: s.keyFile, directory: target }).status, 'restored-held');
    const db = new DatabaseSync(join(target, 'ledger.sqlite'), { readOnly: true });
    try {
      assert.deepEqual(db.prepare('SELECT * FROM events ORDER BY seq LIMIT ?').all(s.original.length), s.original);
      assert.deepEqual(db.prepare('SELECT * FROM tenants').all(), s.tenants);
      for (const [table, rows] of Object.entries(s.financial)) assert.deepEqual(db.prepare(`SELECT * FROM ${table}`).all(), rows);
      assert.equal(db.prepare('SELECT kind FROM events ORDER BY seq DESC LIMIT 1').get()!.kind, 'gateway_restore_held');
      assert.ok(db.prepare('SELECT value FROM settings WHERE key=?').get(RESTORE_HOLD_SETTING));
    } finally { db.close(); }
    assert.deepEqual(readFileSync(join(target, 'connectors.json')), readFileSync(s.registry));
    assert.equal(readFileSync(join(target, 'secrets', 'REALBUD_COMPOSIO_PROJECT_FICTIONAL'), 'utf8'), 'ak_fictional_only\n');
    assert.throws(() => new LedgerDatabase(join(target, 'ledger.sqlite')), /gateway_restored_state_held/);
    unlinkSync(join(target, RESTORE_HOLD_FILE)); // DB authority remains if the sidecar is omitted.
    assert.throws(() => new LedgerDatabase(join(target, 'ledger.sqlite')), /gateway_restored_state_held/);
    assert.throws(() => updateRegistry(join(target, 'connectors.json'), () => ({ devices: [] })), /gateway_restored_state_held/);
    assert.throws(() => fileSecretStore(join(target, 'secrets')), /gateway_restored_state_held/);
    const stopped = fixture(); try {
      stopped.ledger.db.run('INSERT INTO settings(key,value) VALUES(?,?)', RESTORE_HOLD_SETTING, '{}'); let calls = 0;
      assert.throws(() => composeGateway({ ledger: stopped.ledger, env: { REALBUD_ENABLE_PROVIDER: '1', REALBUD_PAYMENT_MODE: 'live' }, fetch: async () => { calls++; throw Error('no external'); }, allowedOrigins: new Set(), portal: { async authenticate() { throw Error('unused'); } } }), /gateway_restored_state_held/); assert.equal(calls, 0);
    } finally { stopped.close(); }
    const second = join(s.outer, 'exports', 'restored.json'); await exportGatewayBackup({ directory: target, registry: join(target, 'connectors.json'), secrets: join(target, 'secrets'), keyFile: s.keyFile, output: second });
    assert.equal(verifyGatewayBackup({ archive: second, keyFile: s.keyFile, scratchDirectory: join(s.outer, 'verify') }).status, 'verified');
  } finally { s.close(); }
});
test('wrong recovery key, damaged/truncated archive and nonempty restore target fail before state publication', async () => {
  const s = setup(); try {
    await exportGatewayBackup(s.config); const original = readFileSync(s.output), wrong = join(s.outer, 'other-key', 'key'); createGatewayRecoveryKey(wrong);
    for (const damage of ['wrong', 'truncated', 'tampered']) {
      const target = join(s.outer, `target-${damage}`);
      if (damage === 'truncated') writeFileSync(s.output, original.subarray(0, 100));
      if (damage === 'tampered') { const env = JSON.parse(original.toString()); env.ciphertext = `${env.ciphertext.slice(0, -8)}AAAAAAAA`; writeFileSync(s.output, JSON.stringify(env)); }
      assert.throws(() => restoreGatewayBackup({ archive: s.output, keyFile: damage === 'wrong' ? wrong : s.keyFile, directory: target }), /gateway_backup_verification_failed/);
      assert.deepEqual(readdirSync(target), []); writeFileSync(s.output, original);
    }
    assert.throws(() => restoreGatewayBackup({ archive: s.output, keyFile: s.keyFile, directory: s.root }), /gateway_restore_target_not_empty/);
    await assert.rejects(() => exportGatewayBackup(s.config), /EEXIST/); // no archive overwrite
  } finally { s.close(); }
});
test('private key admission refuses links, loose permissions and state/export colocated custody', async () => {
  const s = setup(); try {
    const linked = join(s.outer, 'recovery', 'linked'); linkSync(s.keyFile, linked);
    await assert.rejects(() => exportGatewayBackup(s.config), /gateway_state_file_permissions/); unlinkSync(linked);
    symlinkSync(s.keyFile, linked); await assert.rejects(() => exportGatewayBackup({ ...s.config, keyFile: linked }), /gateway_backup_aliased_file/); unlinkSync(linked);
    chmodSync(s.keyFile, 0o644); await assert.rejects(() => exportGatewayBackup(s.config), /gateway_state_file_permissions/); chmodSync(s.keyFile, 0o600);
    const inState = join(s.root, 'key'); writeFileSync(inState, readFileSync(s.keyFile), { mode: 0o600 }); await assert.rejects(() => exportGatewayBackup({ ...s.config, keyFile: inState }), /gateway_backup_key_scope/);
    await assert.rejects(() => exportGatewayBackup({ ...s.config, output: join(s.outer, 'recovery', 'archive') }), /gateway_backup_key_scope/);
  } finally { s.close(); }
});
test('an operator-chosen output or key folder open to others is refused and never re-permissioned', async () => {
  const s = setup(); try {
    const shared = join(s.outer, 'shared-exports'), sticky = join(s.outer, 'tmp-like');
    mkdirSync(shared); chmodSync(shared, 0o755); mkdirSync(sticky); chmodSync(sticky, 0o1777);
    await assert.rejects(() => exportGatewayBackup({ ...s.config, output: join(shared, 'archive.json') }), /gateway_state_permissions/);
    assert.throws(() => createGatewayRecoveryKey(join(sticky, 'key')), /gateway_state_permissions/);
    assert.equal(statSync(shared).mode & 0o7777, 0o755); assert.deepEqual(readdirSync(shared), []);
    assert.equal(statSync(sticky).mode & 0o7777, 0o1777); assert.deepEqual(readdirSync(sticky), []);
    // The refused export released maintenance and left no scratch behind.
    acquireRuntimeStateLease(s.root, 'maintenance').release();
    assert.deepEqual(readdirSync(s.root).filter(name => name.startsWith('.gateway-')), []);
  } finally { s.close(); }
});
test('maintenance refuses active database/unknown owners, out-of-root or orphan secret scope and after-await config drift', async () => {
  const s = setup(); try {
    const db = new LedgerDatabase(join(s.root, 'ledger.sqlite')); await assert.rejects(() => exportGatewayBackup(s.config), /gateway_state_in_use/); db.close();
    await assert.rejects(() => exportGatewayBackup({ ...s.config, registry: join(s.outer, 'outside.json') }), /gateway_backup_scope_mismatch/);
    const orphan = join(s.secrets, '.orphan.tmp'); writeFileSync(orphan, 'private unfinished', { mode: 0o600 }); await assert.rejects(() => exportGatewayBackup(s.config), /gateway_backup_unadmitted_secret_file/); unlinkSync(orphan);
    const pending = exportGatewayBackup(s.config); s.config.registry = join(s.root, 'changed.json'); await assert.rejects(() => pending, /gateway_backup_scope_changed/);
    const lease = acquireRuntimeStateLease(s.root, 'maintenance'); lease.release(); assert.ok(stateIdentity(s.root).id);
  } finally { s.close(); }
});
test('nested standalone secret identity cannot bypass a subsequently admitted parent ledger barrier', async () => {
  const outer = mkdtempSync(join(tmpdir(), 'gateway-split-')); try {
    const root = join(outer, 'state'), secrets = join(root, 'secrets'), store = fileSecretStore(secrets);
    store.write('REALBUD_COMPOSIO_PROJECT_FICTIONAL', 'ak_fictional_only');
    const f = fixture(join(root, 'ledger.sqlite')); f.close();
    const keyFile = join(outer, 'key', 'key'), output = join(outer, 'exports', 'backup'); createGatewayRecoveryKey(keyFile);
    const maintenance = acquireRuntimeStateLease(root, 'maintenance');
    try { assert.throws(() => store.write('REALBUD_COMPOSIO_WEBHOOK_FICTIONAL', 'fictional'), /gateway_state_split_root/); }
    finally { maintenance.release(); }
    await assert.rejects(() => exportGatewayBackup({ directory: root, secrets, keyFile, output }), /gateway_(state_split_root|backup_split_state_root)/);
  } finally { rmSync(outer, { recursive: true, force: true }); }
});
test('owner-authenticated foreign paths/schema, file digests and duplicate manifests refuse before target admission', async () => {
  const s = setup(); try {
    await exportGatewayBackup(s.config); const original = readFileSync(s.output);
    const changes: Array<(manifest: any) => void> = [
      value => { value.files[1].path = '../outside.json'; }, value => { value.applicationId = 7; }, value => { value.schemaVersion = 2; },
      value => { value.files[1].sha256 = 'a'.repeat(64); }, value => { value.files.push(value.files[1]); },
      value => { value.files[0].data = Buffer.from('foreign SQLite bytes').toString('base64'); value.files[0].bytes = 20; value.files[0].sha256 = createHash('sha256').update('foreign SQLite bytes').digest('hex'); },
      value => { const prior = value.scope.secrets; value.scope.secrets = `${value.scope.registry}/secrets`; for (const row of value.files) if (row.path.startsWith(`${prior}/`)) row.path = `${value.scope.secrets}/${row.path.slice(prior.length + 1)}`; },
      value => { value.scope.secrets = value.scope.registry; }, value => { value.scope.secrets = 'ledger.sqlite/secrets'; },
    ];
    for (let i = 0; i < changes.length; i++) {
      rewriteManifest(s, changes[i]); const target = join(s.outer, `foreign-${i}`);
      assert.throws(() => restoreGatewayBackup({ archive: s.output, keyFile: s.keyFile, directory: target })); assert.deepEqual(readdirSync(target), []);
      writeFileSync(s.output, original);
    }
  } finally { s.close(); }
});
for (const missing of ['settings', 'events-columns'] as const) {
  test(`owner-authenticated missing ${missing} recovery schema refuses verification and leaves restore target empty`, async () => {
    const s = setup(); try {
      await exportGatewayBackup(s.config); rewriteRequiredSchema(s, 3, missing);
      assert.throws(() => verifyGatewayBackup({ archive: s.output, keyFile: s.keyFile, scratchDirectory: join(s.outer, 'verify') }), /gateway_backup_schema_incomplete/);
      const target = join(s.outer, 'invalid-target');
      assert.throws(() => restoreGatewayBackup({ archive: s.output, keyFile: s.keyFile, directory: target }), /gateway_backup_schema_incomplete/);
      assert.deepEqual(readdirSync(target), []);
    } finally { s.close(); }
  });
}
test('required recovery structures for schema versions1,2,3 remain verifiable and restore only into a hold', async () => {
  const s = setup(); try {
    await exportGatewayBackup(s.config); const original = readFileSync(s.output);
    for (const version of [1, 2, 3]) {
      writeFileSync(s.output, original); rewriteRequiredSchema(s, version);
      assert.equal(verifyGatewayBackup({ archive: s.output, keyFile: s.keyFile, scratchDirectory: join(s.outer, 'verify') }).status, 'verified');
      const target = join(s.outer, `valid-required-schema-${version}`);
      assert.equal(restoreGatewayBackup({ archive: s.output, keyFile: s.keyFile, directory: target }).status, 'restored-held');
      assert.throws(() => new LedgerDatabase(join(target, 'ledger.sqlite')), /gateway_restored_state_held/);
      const db = new DatabaseSync(join(target, 'ledger.sqlite'), { readOnly: true });
      try { assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, version); } finally { db.close(); }
    }
  } finally { s.close(); }
});
test('a process killed during real restore publication leaves the prior hold and never starts a provider-capable runtime', async () => {
  const s = setup(); try {
    await exportGatewayBackup(s.config); const target = join(s.outer, 'interrupted');
    const module = new URL('./gateway-backup.ts', import.meta.url).href;
    const program = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
      const original=fs.linkSync; fs.linkSync=(from,to)=>{original(from,to);if(to===${JSON.stringify(join(realpathSync(s.outer), 'interrupted', 'ledger.sqlite'))})process.kill(process.pid,'SIGKILL');};syncBuiltinESMExports();
      const {restoreGatewayBackup}=await import(${JSON.stringify(module)}); restoreGatewayBackup(${JSON.stringify({ archive: s.output, keyFile: s.keyFile, directory: target })});`;
    const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', program], { env: process.env }); assert.equal(child.signal, 'SIGKILL');
    assert.equal(JSON.parse(readFileSync(join(target, RESTORE_HOLD_FILE), 'utf8')).state, 'in-progress');
    assert.throws(() => new LedgerDatabase(join(target, 'ledger.sqlite')), /gateway_restored_state_held/);
    assert.throws(() => updateRegistry(join(target, 'connectors.json'), () => ({ devices: [] })), /gateway_restored_state_held/);
    assert.throws(() => restoreGatewayBackup({ archive: s.output, keyFile: s.keyFile, directory: target }), /gateway_restore_target_not_empty/);
  } finally { s.close(); }
});
test('a failed scratch allocation releases maintenance in the reusable API without same-PID reclamation', () => {
  const s = setup(); try {
    const backupModule = new URL('./gateway-backup.ts', import.meta.url).href, leaseModule = new URL('./runtime-state-lock.ts', import.meta.url).href;
    const program = `import assert from 'node:assert/strict';import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
      const original=fs.mkdtempSync;fs.mkdtempSync=(prefix,...args)=>{if(String(prefix).startsWith(${JSON.stringify(join(realpathSync(s.root), '.gateway-backup-'))}))throw Object.assign(Error('synthetic'),{code:'ENOSPC'});return original(prefix,...args);};syncBuiltinESMExports();
      const {exportGatewayBackup}=await import(${JSON.stringify(backupModule)});const {acquireRuntimeStateLease}=await import(${JSON.stringify(leaseModule)});
      await assert.rejects(()=>exportGatewayBackup(${JSON.stringify(s.config)}),{code:'ENOSPC'});const lease=acquireRuntimeStateLease(${JSON.stringify(s.root)},'maintenance');lease.release();`;
    const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', program], { env: process.env }); assert.equal(child.status, 0, child.stderr.toString());
  } finally { s.close(); }
});
