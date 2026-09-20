// Key-authenticated admission: the project-key equivalent of reserve/dispatch.
// Pins the parts that differ from the grant path (provenance, key state, TTL)
// and the parts that must NOT differ (caps, billing boundary, settlement).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './testing.ts';
import { ProjectKeys } from './keys.ts';

function keyed() {
  const f = fixture();
  const keys = new ProjectKeys(f.ledger);
  const minted = keys.mint({ companyId: f.tenant.companyId, project: 'realbud', environment: 'production' });
  const record = keys.verify(minted.key);
  const auth = { companyId: record.companyId, keyId: record.id, project: record.project };
  const bound = { input_tokens: 10, cache_read_tokens: 5, output_tokens: 4 };
  const fingerprint = 'ab'.repeat(32);
  return { f, keys, minted, record, auth, bound, fingerprint };
}

test('a key-authenticated call reserves, dispatches and settles with project attribution', () => {
  const { f, auth, bound, fingerprint } = keyed();
  const reserved = f.ledger.reserveKey(auth, 'fixture-text', f.card.version, fingerprint, bound);
  assert.equal(reserved.state, 'reserved');
  assert.equal(reserved.memberId, `key:${auth.keyId}`);
  assert.equal(reserved.jobId, 'project:realbud');
  assert.equal(reserved.project, 'realbud');
  assert.equal(reserved.keyId, auth.keyId);
  assert.ok(BigInt(reserved.reservedNanoAud) > 0n);
  f.ledger.dispatchKey(reserved.id, auth, 'synthetic-provider');
  assert.equal(f.ledger.request(reserved.id).state, 'dispatched');
  const settled = f.ledger.settle(reserved.id, 'synthetic-provider', {
    evidenceId: 'key-ev-1', providerRequestId: 'key-pr-1', units: bound, outcome: 'succeeded', source: 'final_usage',
  });
  assert.equal(settled.state, 'settled');
  assert.equal(settled.chargedNanoAud, settled.retailNanoAud);
  assert.ok(BigInt(settled.chargedNanoAud) > 0n);
});

test('a revoked key is refused at reserve', () => {
  const { f, keys, record, auth, bound, fingerprint } = keyed();
  keys.revoke(record.id);
  assert.throws(() => f.ledger.reserveKey(auth, 'fixture-text', f.card.version, fingerprint, bound), /key_revoked/);
});

test('unknown and mis-bound keys are the same refusal', () => {
  const { f, auth, bound, fingerprint } = keyed();
  assert.throws(() => f.ledger.reserveKey({ ...auth, keyId: '0'.repeat(16) }, 'fixture-text', f.card.version, fingerprint, bound), /invalid_key/);
  assert.throws(() => f.ledger.reserveKey({ ...auth, project: 'someone-else' }, 'fixture-text', f.card.version, fingerprint, bound), /invalid_key/);
});

test('the tenant request cap still bounds a key-authenticated call', () => {
  const { f, auth, fingerprint } = keyed();
  assert.throws(() => f.ledger.reserveKey(auth, 'fixture-text', f.card.version, fingerprint, { input_tokens: 2000 }), /request_cap_exceeded/);
});

test('dispatch from another key or company is a scope conflict', () => {
  const { f, auth, bound, fingerprint } = keyed();
  const reserved = f.ledger.reserveKey(auth, 'fixture-text', f.card.version, fingerprint, bound);
  assert.throws(() => f.ledger.dispatchKey(reserved.id, { ...auth, keyId: 'f'.repeat(16) }, 'synthetic-provider'), /dispatch_scope_conflict/);
  assert.throws(() => f.ledger.dispatchKey(reserved.id, { ...auth, companyId: 'company-b' }, 'synthetic-provider'), /dispatch_scope_conflict/);
});

test('crossing a billing period between reserve and dispatch is refused', () => {
  const { f, auth, bound, fingerprint } = keyed();
  // 2026-09-30 23:55 Brisbane civil time (UTC+10, no DST).
  const close = Date.parse('2026-09-30T13:55:00Z');
  f.setTime(close);
  const reserved = f.ledger.reserveKey(auth, 'fixture-text', f.card.version, fingerprint, bound);
  f.setTime(close + 9 * 60 * 1000); // 00:04 next month, still inside the 10-minute TTL
  assert.throws(() => f.ledger.dispatchKey(reserved.id, auth, 'synthetic-provider'), /billing_boundary_changed/);
});

test('a reservation past its TTL cannot dispatch', () => {
  const { f, auth, bound, fingerprint } = keyed();
  const reserved = f.ledger.reserveKey(auth, 'fixture-text', f.card.version, fingerprint, bound);
  f.setTime(f.now() + 11 * 60 * 1000);
  assert.throws(() => f.ledger.dispatchKey(reserved.id, auth, 'synthetic-provider'), /call_expired/);
});

test('activeCard requires an acceptance; a tenant without one has no service', () => {
  const { f } = keyed();
  assert.equal(f.ledger.activeCard('company-a').version, 'fixture-r1');
  f.ledger.provisionTenant({ ...f.tenant, companyId: 'company-b', licenseId: 'license-b' });
  assert.throws(() => f.ledger.activeCard('company-b'), /rates_not_accepted/);
});
