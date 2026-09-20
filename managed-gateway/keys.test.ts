// Project-scoped keys: the properties that matter are the ones an attacker
// would exploit, so they are pinned here — the secret never persists, tampering
// fails closed, revocation is loud, and a key can never outscope its tenant.

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './testing.ts';
import { KEY_PREFIX, ProjectKeys, type MintKeyInput } from './keys.ts';

const cleanups: (() => void)[] = [];
function setup() {
  const f = fixture();
  cleanups.push(f.close);
  return { f, keys: new ProjectKeys(f.ledger) };
}
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function mint(keys: ProjectKeys, over: Partial<MintKeyInput> = {}) {
  return keys.mint({ companyId: 'company-a', project: 'realbud-desktop', environment: 'production', label: 'owner@agency.example', ...over });
}

test('a minted key is shown once, and only its hash is stored', () => {
  const { f, keys } = setup();
  const { key, record } = mint(keys);
  assert.match(key, /^rbk_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);
  assert.equal(key.startsWith(`${KEY_PREFIX}_${record.id}_`), true);
  assert.equal(record.hash.length, 64);
  const secret = key.slice(`${KEY_PREFIX}_${record.id}_`.length);
  assert.notEqual(record.hash, secret);

  // The secret must not be recoverable from any durable row.
  for (const row of f.db.all<{ body: string }>('SELECT * FROM project_keys')) {
    assert.equal(row.body.includes(secret), false, 'key table must not contain the secret');
    assert.equal(row.body.includes(record.hash), true, 'the hash is what is stored');
  }
  for (const row of f.db.all<{ body: string }>('SELECT * FROM events')) {
    assert.equal(row.body.includes(secret), false, 'audit events must not contain the secret');
  }
  assert.equal(f.db.all<{ kind: string }>("SELECT kind FROM events WHERE kind='key_minted'").length, 1);
});

test('a key verifies and records last-used without an audit event', () => {
  const { f, keys } = setup();
  const { key } = mint(keys);
  f.setTime(f.now() + 5000);
  const before = f.db.all('SELECT * FROM events').length;
  const record = keys.verify(key);
  assert.equal(record.companyId, 'company-a');
  assert.equal(record.project, 'realbud-desktop');
  assert.equal(record.environment, 'production');
  assert.equal(record.lastUsedAt, f.now());
  assert.equal(f.db.all('SELECT * FROM events').length, before, 'last-used is telemetry, not an event');
  assert.equal(keys.get(record.id).lastUsedAt, f.now());
});

test('a secret containing the delimiter still verifies (base64url can emit underscores)', () => {
  const { keys } = setup();
  let withUnderscore: string | undefined;
  for (let i = 0; i < 300 && withUnderscore === undefined; i += 1) {
    const { key } = mint(keys);
    const secret = key.slice(key.indexOf('_', key.indexOf('_') + 1) + 1);
    if (secret.includes('_')) withUnderscore = key;
  }
  assert.ok(withUnderscore, 'expected at least one base64url secret to contain an underscore');
  assert.equal(typeof keys.verify(withUnderscore!).id, 'string');
});

test('a tampered secret, an unknown id and a malformed key are one refusal', () => {
  const { keys } = setup();
  const { key, record } = mint(keys);
  const prefix = `${KEY_PREFIX}_${record.id}_`;
  const secret = key.slice(prefix.length);
  const flipped = secret.slice(0, -1) + (secret.endsWith('A') ? 'B' : 'A');
  assert.throws(() => keys.verify(prefix + flipped), /invalid_key/);
  assert.throws(() => keys.verify(`${KEY_PREFIX}_0000000000000000_${secret}`), /invalid_key/);
  assert.throws(() => keys.verify('not-a-key'), /invalid_key/);
  assert.throws(() => keys.verify(`${KEY_PREFIX}_${record.id}`), /invalid_key/);
  assert.throws(() => keys.verify(''), /invalid_key/);
});

test('revocation fails closed, is idempotent, and keeps the first timestamp', () => {
  const { f, keys } = setup();
  const { key, record } = mint(keys);
  const revoked = keys.revoke(record.id);
  assert.equal(typeof revoked.revokedAt, 'number');
  assert.throws(() => keys.verify(key), /key_revoked/);
  f.setTime(f.now() + 60_000);
  const again = keys.revoke(record.id);
  assert.equal(again.revokedAt, revoked.revokedAt, 'a second revoke must not move the timestamp');
  assert.equal(f.db.all<{ kind: string }>("SELECT kind FROM events WHERE kind='key_revoked'").length, 1);
  assert.throws(() => keys.revoke('0000000000000000'), /unknown_key/);
});

test('expiry fails closed after the deadline and cannot be minted in the past', () => {
  const { f, keys } = setup();
  assert.throws(() => mint(keys, { expiresAt: f.now() }), /key_expiry_in_past/);
  const { key } = mint(keys, { expiresAt: f.now() + 60_000 });
  assert.equal(typeof keys.verify(key).id, 'string');
  f.setTime(f.now() + 61_000);
  assert.throws(() => keys.verify(key), /key_expired/);
});

test('a key never outscopes its tenant and listing is company-scoped', () => {
  const { keys } = setup();
  assert.throws(() => mint(keys, { companyId: 'company-x' }), /tenant_unavailable/);
  const first = mint(keys);
  mint(keys, { project: 'clawconnect', environment: 'staging' });
  const list = keys.list('company-a');
  assert.equal(list.length, 2);
  assert.equal(list.every((k) => k.companyId === 'company-a'), true);
  assert.equal(JSON.stringify(list).includes(first.record.hash), false, 'public views never carry the hash');
});

test('rotation revokes the old key and preserves the binding', () => {
  const { keys } = setup();
  const { key, record } = mint(keys);
  const rotated = keys.rotate(record.id);
  assert.equal(rotated.replaced, record.id);
  assert.throws(() => keys.verify(key), /key_revoked/);
  const fresh = keys.verify(rotated.key);
  assert.equal(fresh.project, record.project);
  assert.equal(fresh.environment, record.environment);
  assert.equal(fresh.label, record.label);
  assert.notEqual(fresh.id, record.id);
});

test('mint input is validated before anything is stored', () => {
  const { f, keys } = setup();
  assert.throws(() => mint(keys, { project: '' }), /invalid_id/);
  assert.throws(() => mint(keys, { environment: 'sp ace' }), /invalid_id/);
  assert.throws(() => mint(keys, { label: '' }), /invalid_key_label/);
  assert.throws(() => mint(keys, { label: 'x'.repeat(201) }), /invalid_key_label/);
  assert.throws(() => mint(keys, { expiresAt: 1.5 as never }), /invalid_integer/);
  assert.equal(f.db.all('SELECT * FROM project_keys').length, 0);
});
