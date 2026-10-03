// Preserve only a disposable fictional source-bills rehearsal for a source restart.
import assert from 'node:assert/strict';
import { chmodSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { backup, DatabaseSync } from 'node:sqlite';

const receipt = JSON.parse(readFileSync(process.argv[2], 'utf8'));
assert.equal(receipt.kind, 'fictional-source-ui-rehearsal');
assert.match(basename(receipt.temp), /^realbud-bills-interactive-/);
assert.equal(receipt.data, join(receipt.temp, 'data'));
const base = new URL(receipt.baseUrl), fixture = new URL(receipt.fixtureUrl);
for (const url of [base, fixture]) { assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.protocol, 'http:'); assert.notEqual(url.port, '8799'); }
const health = await (await fetch(base + 'api/health')).json();
assert.equal(health.pid, receipt.servicePid);
const response = await fetch(new URL('/v1/connectors/mail-scan', fixture), { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer rbc_${'c'.repeat(64)}`, 'x-realbud-profile': 'property' }, body: JSON.stringify({ expectedAccountId: 'fictional-bills', scope: { windowStartAt: 0, windowEndAt: Date.now() } }) });
assert.equal(response.status, 200);
const mailbox = await response.json();
assert.equal(mailbox.accountId, 'fictional-bills');
assert.ok(mailbox.threads.length && mailbox.threads.every(thread => thread.messages.every(message => message.from === 'utility@example.test' && message.body.startsWith('Fictional Oak Street'))));
const folder = mkdtempSync(join(tmpdir(), 'realbud-fictional-preserved-')), data = join(folder, 'data');
mkdirSync(data, { mode: 0o700 });
cpSync(receipt.data, data, { recursive: true, preserveTimestamps: true });
const restrict = path => { const info = lstatSync(path); if (info.isSymbolicLink()) throw new Error('Fictional snapshots cannot contain symbolic links.'); chmodSync(path, info.isDirectory() ? 0o700 : info.mode & 0o700); if (info.isDirectory()) for (const name of readdirSync(path)) restrict(join(path, name)); };
restrict(data);
// SQLite backup yields a consistent snapshot while the owned service is idle.
for (const file of ['workflow-state.sqlite', 'private-backup-v2/operations/operations.sqlite']) {
  for (const suffix of ['-wal', '-shm', '-journal']) rmSync(join(data, file + suffix), { force: true });
  const database = new DatabaseSync(join(receipt.data, file), { readOnly: true });
  try { await backup(database, join(data, file)); } finally { database.close(); }
}
const state = { kind: 'fictional-source-ui-snapshot', data, sourceAt: mailbox.threads[0].messages[0].at, sourceDate: receipt.sourceDate, dueDate: receipt.dueDate, nextDueDate: receipt.nextDueDate, propertyId: receipt.propertyId, threads: mailbox.threads, from: process.argv[2], createdAt: new Date().toISOString() };
const path = join(folder, 'resume.json');
writeFileSync(path, JSON.stringify(state, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ resumeState: path, data, conversations: mailbox.threads.length }));
