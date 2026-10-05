import { mkdtemp } from 'node:fs/promises';
import { statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createInspectionHistoryStore, matchHistoryCsv, readHistoryDate } from './inspection-history.ts';
import { removeFixture } from './testing/private-fixture.ts';

const directories: string[] = [];
const store = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'realbud-inspection-history-')); directories.push(directory);
  const file = join(directory, 'inspection-history.json');
  return { file, store: createInspectionHistoryStore({ file, now: () => 1_000 }) };
};
afterEach(async () => { await Promise.all(directories.splice(0).map(path => removeFixture(path))); });

const properties = [
  { id: 'SYN-P01', address: '1 Fictional Street, Northvale' },
  { id: 'SYN-P02', address: '2 Fictional Street, Northvale' },
  { id: 'SYN-D1', address: '9 Twin Lane, Bayside' },
  { id: 'SYN-D2', address: '9 Twin Lane, Bayside' },
];
const csv = [
  'Property address or id,Area,Last completed date,Last planned date,Access notes',
  'SYN-P01,Northvale,2026-05-10,2026-05-10,',
  '"2 fictional street,  northvale",Northvale,12/05/2026,,"Fictional: call first, then key"',
  '3 Unknown Road,Northvale,2026-05-20,,',
  '9 Twin Lane, Bayside,Bayside,2026-06-01,,',
].join('\n');

describe('inspection history CSV', () => {
  it('reads ISO and Australian dates and refuses unreadable ones', () => {
    expect(readHistoryDate('2026-05-10')).toBe('2026-05-10');
    expect(readHistoryDate('1/5/2026')).toBe('2026-05-01');
    expect(readHistoryDate('')).toBeNull();
    expect(readHistoryDate('31/02/2026')).toBeUndefined();
    expect(readHistoryDate('May 2026')).toBeUndefined();
  });

  it('matches by id or exact address and holds everything else with a reason', () => {
    const { records, unmatched } = matchHistoryCsv(csv, properties);
    expect(records['SYN-P01']).toEqual({ area: 'Northvale', lastCompleted: '2026-05-10', lastPlanned: '2026-05-10', accessNote: '' });
    expect(records['SYN-P02']).toMatchObject({ lastCompleted: '2026-05-12', lastPlanned: null, accessNote: 'Fictional: call first, then key' });
    expect(unmatched.map(u => [u.row, u.reason])).toEqual([
      [4, 'No Desk property has this id or exact address.'],
      [5, 'No Desk property has this id or exact address.'], // unquoted comma splits the address: never guessed
    ]);
    const twins = matchHistoryCsv('property,area,last completed\n"9 Twin Lane, Bayside",Bayside,2026-06-01', properties);
    expect(twins.unmatched[0]?.reason).toBe('More than one Desk property has this address.');
    expect(() => matchHistoryCsv('foo,bar\n1,2', properties)).toThrow(/columns/);
  });

  it('imports with a revision check, keeps the held rows, writes 0600 and keeps a damaged file', async () => {
    const { file, store: history } = await store();
    const saved = await history.importCsv({ csv, properties, expectedRevision: 0 });
    expect(saved).toMatchObject({ revision: 1, lastImport: { at: 1_000, matched: 2, unmatched: 2 } });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    await expect(history.importCsv({ csv, properties, expectedRevision: 0 })).rejects.toMatchObject({ status: 409 });
    const again = await history.importCsv({ csv: 'id,area,last completed\nSYN-P01,Hillcrest,2026-06-01', properties, expectedRevision: 1 });
    expect(again.records['SYN-P01']?.area).toBe('Hillcrest');
    expect(again.records['SYN-P02']).toBeDefined();
    expect(again.unmatched).toEqual([]);
    writeFileSync(file, '{"version":1}', { mode: 0o600 });
    await expect(history.read()).rejects.toMatchObject({ status: 503 });
  });
});
