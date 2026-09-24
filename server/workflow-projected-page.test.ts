import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { WorkflowDatabase } from './workflow-database.ts';

const key = Buffer.alloc(32, 37);
const fixtures: { dir: string; databases: (WorkflowDatabase | DatabaseSync)[] }[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    for (const database of fixture.databases) database.close();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'realbud-projected-page-'));
  const db = new WorkflowDatabase({ dir, key });
  const raw = new DatabaseSync(join(dir, 'workflow-state.sqlite'));
  raw.exec('PRAGMA busy_timeout=50; CREATE TABLE write_probe (value INTEGER);');
  fixtures.push({ dir, databases: [db, raw] });
  return { dir, db, raw, probe: () => raw.prepare('INSERT INTO write_probe VALUES (1)').run() };
}
const summary = (record: { id: string; revision: number; value: { title: string } }) => ({ id: record.id, revision: record.revision, title: record.value.title });

describe('projected encrypted workflow pages', () => {
  it('keeps descending insertion cursors, deduplicates existing identities, and excludes interleaved inserts', () => {
    const { db } = fixture();
    for (let i = 0; i < 7; i++) db.create('bank', `bank:${i}`, { title: `Source ${i}` });
    db.create('bank', 'bank:3', { title: 'Must not replace the saved source' });
    db.create('other-kind', 'other:1', { title: 'Unrelated work' });
    db.create('bank', 'excluded:1', { title: 'Other prefix' });
    const before = db.highWatermark('bank');
    const first = db.projectPage('bank', { before, limit: 3, prefix: 'bank:' }, summary);
    expect(first.records.map(record => record.id)).toEqual(['bank:6', 'bank:5', 'bank:4']);
    expect(first.sequences).toEqual([7, 6, 5]);
    expect(first.next).toBe(5);
    db.create('bank', 'bank:7', { title: 'Inserted after the first page' });
    db.update<{ title: string }>('bank', 'bank:1', 1, () => ({ title: 'Reviewed current source' }));
    const records = [...first.records];
    let cursor = first.next;
    while (cursor !== null) {
      const next = db.projectPage('bank', { before: cursor, limit: 2, prefix: 'bank:' }, summary);
      records.push(...next.records);
      cursor = next.next;
    }
    expect(records.map(record => record.id)).toEqual(['bank:6', 'bank:5', 'bank:4', 'bank:3', 'bank:2', 'bank:1', 'bank:0']);
    expect(new Set(records.map(record => record.id)).size).toBe(7);
    expect(records.find(record => record.id === 'bank:1')).toEqual({ id: 'bank:1', revision: 2, title: 'Reviewed current source' });
    expect(records.find(record => record.id === 'bank:3')?.title).toBe('Source 3');
  });

  it('returns no continuation at an exact page boundary, an empty kind, or an exhausted cursor', () => {
    const { db } = fixture();
    const project = vi.fn(summary);
    expect(db.projectPage('bank', {}, project)).toEqual({ records: [], sequences: [], next: null });
    expect(project).not.toHaveBeenCalled();
    db.create('bank', 'bank:0', { title: 'First' });
    db.create('bank', 'bank:1', { title: 'Second' });
    expect(db.projectPage('bank', { limit: 2 }, project)).toEqual({ records: [
      { id: 'bank:1', revision: 1, title: 'Second' }, { id: 'bank:0', revision: 1, title: 'First' },
    ], sequences: [2, 1], next: null });
    expect(project).toHaveBeenCalledTimes(2);
    expect(db.projectPage('bank', { before: 1 }, project)).toEqual({ records: [], sequences: [], next: null });
  });

  it.each([
    { limit: 0 }, { limit: 201 }, { limit: 1.2 }, { limit: NaN },
    { before: 0 }, { before: 1.2 }, { before: Infinity }, { before: Number.MAX_SAFE_INTEGER + 1 },
    { prefix: '%' }, { prefix: 'bank_' }, { prefix: 'a'.repeat(161) },
  ])('rejects an invalid cursor option before reading or projecting: %j', options => {
    const { db, dir } = fixture();
    const before = readFileSync(join(dir, 'workflow-state.sqlite'));
    const project = vi.fn();
    expect(() => db.projectPage('bank', options, project)).toThrow(expect.objectContaining({ status: 409 }));
    expect(project).not.toHaveBeenCalled();
    expect(readFileSync(join(dir, 'workflow-state.sqlite'))).toEqual(before);
  });

  it('rejects an invalid kind before invoking the projector', () => {
    const { db } = fixture();
    const project = vi.fn();
    expect(() => db.projectPage('bank;DROP TABLE workflow_records', {}, project)).toThrow(expect.objectContaining({ status: 400 }));
    expect(project).not.toHaveBeenCalled();
  });

  it('does not decode the lookahead and releases the SQLite reader when a page ends early', () => {
    const { db, raw, probe } = fixture();
    db.create('bank', 'bank:old', { title: 'Older source' });
    db.create('bank', 'bank:new', { title: 'Current source' });
    raw.prepare('UPDATE workflow_records SET payload=? WHERE id=?').run('not an encrypted record', 'bank:old');
    const project = vi.fn(summary);
    expect(db.projectPage('bank', { limit: 1 }, project)).toEqual({
      records: [{ id: 'bank:new', revision: 1, title: 'Current source' }], sequences: [2], next: 2,
    });
    expect(project).toHaveBeenCalledTimes(1);
    expect(probe).not.toThrow();
    expect(() => db.projectPage('bank', { before: 2 }, project)).toThrow(expect.objectContaining({ status: 503 }));
    expect(probe).not.toThrow();
  });

  it('preserves validator errors, releases a failed reader, and rolls back the surrounding transaction', () => {
    const { db, raw, probe } = fixture();
    db.create('bank', 'bank:original', { title: 'Original source' });
    const error = Object.assign(new Error('This saved batch requires review.'), { status: 422 });
    let caught: unknown;
    try {
      db.transaction(() => {
        db.create('bank', 'bank:temporary', { title: 'Must roll back' });
        db.projectPage('bank', {}, () => { throw error; });
      });
    } catch (failure) { caught = failure; }
    expect(caught).toBe(error);
    expect(db.get('bank', 'bank:temporary')).toBeUndefined();
    expect(db.get('bank', 'bank:original')).toEqual({ id: 'bank:original', revision: 1, value: { title: 'Original source' } });
    expect(probe).not.toThrow();
    expect(raw.prepare('SELECT count(*) AS count FROM write_probe').get()).toEqual({ count: 1 });
    expect(db.transaction(() => db.projectPage('bank', {}, summary).records)).toHaveLength(1);
  });

  it('cleans up a nontransactional projection failure and hides unexpected error details', () => {
    const { db, probe } = fixture();
    db.create('bank', 'bank:1', { title: 'Synthetic confidential source' });
    db.create('bank', 'bank:2', { title: 'Second source' });
    let caught: unknown;
    try { db.projectPage('bank', {}, () => { throw new Error('Accidental confidential provider detail'); }); }
    catch (error) { caught = error; }
    expect(caught).toMatchObject({ status: 503 });
    expect(String(caught)).not.toContain('confidential');
    expect(probe).not.toThrow();
    expect(db.projectPage('bank', {}, summary).records).toHaveLength(2);
  });

  it('reports corrupt ciphertext and SQLite failures as recovery holds without leaking saved bytes', () => {
    const { db, raw, dir, probe } = fixture();
    db.create('bank', 'bank:1', { title: 'Saved source' });
    raw.prepare('UPDATE workflow_records SET payload=?').run('sensitive malformed ciphertext');
    const before = readFileSync(join(dir, 'workflow-state.sqlite'));
    const project = vi.fn(summary);
    let caught: unknown;
    try { db.projectPage('bank', {}, project); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ status: 503 });
    expect(String(caught)).not.toContain('sensitive');
    expect(project).not.toHaveBeenCalled();
    expect(readFileSync(join(dir, 'workflow-state.sqlite'))).toEqual(before);
    expect(probe).not.toThrow();
    raw.exec('DROP TABLE workflow_records');
    expect(() => db.projectPage('bank', {}, project)).toThrow(expect.objectContaining({ status: 503 }));
  });

  it('summarizes 32 near-limit encrypted records in a child whose heap cannot hold their full page', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'realbud-projected-memory-'));
    fixtures.push({ dir, databases: [] });
    const script = `
      import assert from 'node:assert/strict';
      import { DatabaseSync } from 'node:sqlite';
      import { join } from 'node:path';
      import { getHeapStatistics } from 'node:v8';
      import { WorkflowDatabase, WORKFLOW_MAX_ENCRYPTED_RECORD_LENGTH } from ${JSON.stringify(new URL('./workflow-database.ts', import.meta.url).href)};
      const dir = process.argv[1], key = Buffer.alloc(32, 37), count = 32, size = 5_850_000;
      const db = new WorkflowDatabase({ dir, key });
      for (let i = 0; i < count; i++) db.create('large', 'large:' + i, { index: i, body: 'x'.repeat(size) + i }, null);
      global.gc();
      const raw = new DatabaseSync(join(dir, 'workflow-state.sqlite'));
      const lengths = raw.prepare('SELECT min(length(payload)) AS smallest, max(length(payload)) AS largest, sum(length(payload)) AS total FROM workflow_records').get();
      raw.close();
      assert(lengths.smallest > WORKFLOW_MAX_ENCRYPTED_RECORD_LENGTH * 0.97);
      assert(lengths.largest <= WORKFLOW_MAX_ENCRYPTED_RECORD_LENGTH);
      const heapLimit = getHeapStatistics().heap_size_limit;
      assert(heapLimit <= 128 * 1024 * 1024);
      assert(lengths.total > heapLimit);
      assert(count * size > heapLimit);
      const page = db.projectPage('large', { limit: 100 }, record => {
        assert.equal(record.value.body, 'x'.repeat(size) + record.value.index);
        return { id: record.id, index: record.value.index, length: record.value.body.length };
      });
      assert.equal(page.records.length, count);
      assert.equal(page.next, null);
      assert.deepEqual(page.records.map(record => record.index), Array.from({ length: count }, (_, i) => count - i - 1));
      db.close();
      console.log(JSON.stringify({ count, smallestEncryptedRecord: lengths.smallest, encryptedPageBytes: lengths.total, decodedBodyBytes: count * size, heapLimit }));
    `;
    const { stdout } = await promisify(execFile)(process.execPath, [
      '--max-old-space-size=96', '--max-semi-space-size=4', '--expose-gc', '--experimental-strip-types', '--input-type=module', '-e', script, dir,
    ], {
      cwd: dir, timeout: 60_000, maxBuffer: 256_000, windowsHide: true,
      env: { PATH: dirname(process.execPath), HOME: dir, USERPROFILE: dir, SystemRoot: process.env.SystemRoot },
    });
    const result = JSON.parse(stdout.trim()) as { count: number; smallestEncryptedRecord: number; encryptedPageBytes: number; decodedBodyBytes: number; heapLimit: number };
    expect(result.count).toBe(32);
    expect(result.heapLimit).toBeLessThanOrEqual(128 * 1024 * 1024);
    expect(result.smallestEncryptedRecord).toBeGreaterThan(7_760_000);
    expect(result.encryptedPageBytes).toBeGreaterThan(result.heapLimit);
    expect(result.decodedBodyBytes).toBeGreaterThan(result.heapLimit);
  }, 65_000);
});
