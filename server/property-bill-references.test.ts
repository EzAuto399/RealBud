import { privateTempRoot } from './testing/private-fixture.ts';
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPropertyReferenceApi, createPropertyReferenceStore, importPropertyReferences, matchBillReference, readReferenceCell, readReiPeriod, sharedReferences, suggestPatterns } from './property-bill-references.ts';
import { removeFixture } from './testing/private-fixture.ts';

// Fictional book and numbers only.
const properties = [
  { id: 'prop-a', address: '1 Fictional St, Synthville NSW 2000', propertyCode: 'SYN01' },
  { id: 'prop-b', address: '2 Example Rd, Synthville NSW 2000', propertyCode: 'SYN02' },
  { id: 'prop-c', address: '3 Sample Ave, Synthville NSW 2000' },
];
const CSV = [
  'Code,Street,Suburb,Last of Period,Last of Status,Council Rate Number,Water Rate number,Reference Number',
  'SYN01,1 Fictional St,Synthville,2026 JUL,Waiting,"111 222 333",900000001,NIL',
  'SYN02,2 Example Rd,Synthville,2026JAN,PAID,111222333 | 444555,9000000A,12345678901234560000',
  ',3 Sample Avenue,Synthville,,,777888999 l 777888000,,',
  'SYN99,9 Nowhere Pl,Synthville,2026 APR,Unpaid,555666777,,',
].join('\n');

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => removeFixture(path))); });
const store = async () => {
  const directory = privateTempRoot(join(tmpdir(), 'realbud-bill-refs-')); directories.push(directory);
  const file = join(directory, 'property-bill-references.json');
  return { file, store: createPropertyReferenceStore({ file, now: () => 1_000 }) };
};

describe('reference cells', () => {
  it('strips spaces, splits | and " l ", and rejects NIL, letters and spreadsheet-cut numbers with plain reasons', () => {
    expect(readReferenceCell('111 222 333', 'council').refs).toEqual([{ kind: 'council', digits: '111222333', raw: '111 222 333' }]);
    expect(readReferenceCell('123456 | 654321', 'water').refs.map(r => r.digits)).toEqual(['123456', '654321']);
    expect(readReferenceCell('123456 l 654321', 'water').refs.map(r => r.digits)).toEqual(['123456', '654321']);
    expect(readReferenceCell('NIL', 'levy').rejected[0]!.reason).toMatch(/NIL/);
    expect(readReferenceCell('12A456', 'levy').rejected[0]!.reason).toMatch(/letters/);
    expect(readReferenceCell('12345678901234560000', 'levy').rejected[0]!.reason).toMatch(/cut off/);
    expect(readReferenceCell('123456789012345', 'levy').refs).toHaveLength(1);
  });
  it('reads REI periods with or without a space', () => {
    expect(readReiPeriod('2026 JUL')).toBe('2026-07');
    expect(readReiPeriod('2026JAN')).toBe('2026-01');
    expect(readReiPeriod('')).toBeNull();
    expect(readReiPeriod('soon')).toBeNull();
  });
});

describe('import', () => {
  it('matches by code or exact street, holds unmatched rows, keeps REI as an observation and flags shared numbers', () => {
    const result = importPropertyReferences(CSV, properties);
    expect(result.entries.map(e => e.propertyId)).toEqual(['prop-a', 'prop-b', 'prop-c']);
    expect(result.entries[0]).toMatchObject({ code: 'SYN01', rei: { period: '2026-07', status: 'Waiting' } });
    expect(result.entries[2]!.refs.map(r => r.digits)).toEqual(['777888999', '777888000']);
    expect(result.held).toEqual([{ code: 'SYN99', street: '9 Nowhere Pl', reason: expect.stringMatching(/No Desk property/), refs: 1 }]);
    expect(result.rejected.map(r => [r.code, r.kind])).toEqual([['SYN01', 'levy'], ['SYN02', 'water'], ['SYN02', 'levy']]);
    expect(sharedReferences(result.entries)).toEqual([{ kind: 'council', digits: '111222333', propertyIds: ['prop-a', 'prop-b'], message: 'Shared by SYN01 and SYN02 — confirm' }]);
  });
  it('tolerates header spelling and refuses a file without the needed columns', () => {
    expect(importPropertyReferences('CODE,STREET,COUNCIL RATE NUMBER\nSYN01,x,123456', properties).entries[0]!.refs).toHaveLength(1);
    expect(() => importPropertyReferences('Name,Phone\na,b', properties)).toThrow(/CODE or Street/);
  });
  it('suggests a quarterly pattern per property and kind, rolled forward to today', () => {
    const { entries } = importPropertyReferences(CSV, properties);
    const s = suggestPatterns(entries, '2026-10-05');
    expect(s.find(x => x.propertyId === 'prop-a' && x.kind === 'council')).toMatchObject({ intervalMonths: 3, lastPeriod: '2026-07', nextAround: '2026-10', message: 'Suggested from REI: quarterly, next around Oct 2026' });
    expect(s.find(x => x.propertyId === 'prop-b')!.nextAround).toBe('2026-10');
    expect(s.some(x => x.propertyId === 'prop-c')).toBe(false);
  });
});

describe('matching a bill', () => {
  const { entries } = importPropertyReferences(CSV, properties);
  it('matches a whole number even when the bill spaces it differently', () => {
    expect(matchBillReference(entries, 'Water notice. Account 900 000 001 due soon')).toMatchObject({ state: 'matched', propertyId: 'prop-a', kind: 'water', how: 'whole',
      evidence: 'Matched by water rate number 900000001', rei: { period: '2026-07', status: 'Waiting' } });
  });
  it('holds a shared number as ambiguous', () => {
    expect(matchBillReference(entries, 'Assessment 111222333')).toMatchObject({ state: 'ambiguous', propertyIds: ['prop-a', 'prop-b'] });
  });
  it('accepts a 9+ digit number inside a longer run only when unique, and never short ones', () => {
    expect(matchBillReference(entries, 'Ref 0777888999')).toMatchObject({ state: 'matched', propertyId: 'prop-c', how: 'within' });
    expect(matchBillReference(entries, 'Ref 9444555')).toEqual({ state: 'none' });
    expect(matchBillReference(entries, '1 Fictional St, Synthville')).toEqual({ state: 'none' });
  });
});

describe('store and api', () => {
  it('imports with a revision check, writes 0600 and recovers a damaged file without clearing it', async () => {
    const { file, store: refs } = await store();
    const api = createPropertyReferenceApi({ store: refs, properties: () => properties, recovery: () => false, today: () => '2026-10-05' });
    const saved = await api('/api/bill-references', 'PUT', { csv: CSV, expectedRevision: 0 });
    expect(saved).toMatchObject({ status: 200, body: { revision: 1, counts: { properties: 3, refs: { council: 5, water: 1, levy: 0 }, rejected: 3, held: 1, shared: 1 } } });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    await expect(api('/api/bill-references', 'PUT', { csv: CSV, expectedRevision: 0 })).rejects.toMatchObject({ status: 409 });
    expect(await api('/api/bill-references/match', 'POST', { text: 'Account 900000001' })).toMatchObject({ body: { state: 'matched', propertyId: 'prop-a' } });
    await api('/api/bill-references', 'PUT', { csv: CSV, expectedRevision: 1 });
    writeFileSync(file, '{"version":1', { mode: 0o600 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try { expect(await refs.read()).toMatchObject({ revision: 1 }); } finally { warn.mockRestore(); }
    expect(readdirSync(dirname(file)).some(name => name.startsWith('property-bill-references.json.damaged-'))).toBe(true);
  });
  it('refuses imports during book recovery', async () => {
    const { store: refs } = await store();
    const api = createPropertyReferenceApi({ store: refs, properties: () => properties, recovery: () => true });
    await expect(api('/api/bill-references', 'PUT', { csv: CSV, expectedRevision: 0 })).rejects.toMatchObject({ status: 503 });
  });
});
