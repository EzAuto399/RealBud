import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, readFileSync, readdirSync, writeFileSync, symlinkSync, linkSync, chmodSync, statSync, unlinkSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { PrivateBackupPreparedStore, PRIVATE_BACKUP_PREPARED_CHUNK_BYTES as CHUNK, PRIVATE_BACKUP_PREPARED_LIMITS, preparedStorageBudget, preparedRollbackJournalBounds } from './private-backup-prepared.ts';
import { removeFixture } from './testing/private-fixture.ts';

const roots: string[] = [], stores: PrivateBackupPreparedStore[] = [];
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
async function fixture(limits?: Parameters<typeof PrivateBackupPreparedStore.create>[0]['limits']) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'RealBud prepared Ω ')); roots.push(root);
  const directory = join(root, 'prepared'), key = randomBytes(32), workspaceId = randomUUID();
  const store = await PrivateBackupPreparedStore.create({ directory, key, workspaceId, limits }); stores.push(store);
  const options = { directory, key, workspaceId, storeId: store.storeId }; return { root, store, options };
}
async function reopen(options: Parameters<typeof PrivateBackupPreparedStore.open>[0]) { const store = await PrivateBackupPreparedStore.open(options); stores.push(store); return store; }
async function* bytes(value: Buffer | string) { const buffer = Buffer.from(value); for (let offset = 0; offset < buffer.length; offset += CHUNK) yield buffer.subarray(offset, offset + CHUNK); }
async function digest(input: AsyncIterable<Buffer>) { const h = createHash('sha256'); let count = 0; for await (const b of input) { expect(b.length).toBeLessThanOrEqual(CHUNK); h.update(b); count += b.length; } return { digest: h.digest('hex'), bytes: count }; }
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); for (const root of roots.splice(0)) await removeFixture(root); });

describe('exact encrypted prepared restore artifacts', () => {
  it('streams a database beyond the v1 48 MiB limit and reopens exact bytes with immutable removal metadata', async () => {
    const f = await fixture(), total = 52 * CHUNK + 17, h = createHash('sha256');
    async function* generated() { for (let offset = 0; offset < total; offset += CHUNK) { const b = Buffer.alloc(Math.min(CHUNK, total - offset), Math.floor(offset / CHUNK) % 251); h.update(b); yield b; } }
    await f.store.addFile('workflow-state.sqlite', null, generated()); const expected = h.digest('hex');
    await f.store.addRemoval('vault/USER.md', sha('fictional before'));
    expect(() => [...f.store.entries()]).toThrow(/sealed/);
    const summary = await f.store.seal(); await f.store.close();
    const opened = await reopen(f.options); expect(await opened.validate()).toEqual(summary);
    expect(await digest(opened.readFile('workflow-state.sqlite'))).toEqual({ digest: expected, bytes: total });
    expect([...opened.entries()][1]).toMatchObject({ path: 'vault/USER.md', beforeHash: sha('fictional before'), intendedHash: null, bytes: 0 });
    await expect(opened.addFile('vault/README.md', null, bytes('changed'))).rejects.toThrow(/sealed/);
    await expect(opened.readFile('vault/USER.md')[Symbol.asyncIterator]().next()).rejects.toThrow(/not found/);
  }, 30_000);

  it('authenticates owned identity and does not persist plaintext names, content or keys', async () => {
    const f = await fixture(), text = 'Fictional secret content Ω';
    await f.store.addFile('vault/USER.md', null, bytes(text)); await f.store.seal(); await f.store.close();
    const disk = readFileSync(join(f.options.directory, 'prepared.sqlite'));
    for (const needle of [Buffer.from(text), Buffer.from('vault/USER.md'), f.options.key]) expect(disk.includes(needle)).toBe(false);
    await expect(reopen({ ...f.options, key: randomBytes(32) })).rejects.toThrow();
    await expect(reopen({ ...f.options, workspaceId: randomUUID() })).rejects.toThrow();
    await expect(reopen({ ...f.options, storeId: randomUUID() })).rejects.toThrow();
  });

  it.each(['chunk', 'ordinal', 'orphan', 'schema'])('refuses %s corruption before a complete artifact is accepted', async attack => {
    const f = await fixture(); await f.store.addFile('vault/USER.md', null, bytes(Buffer.alloc(CHUNK + 1, 3))); await f.store.seal(); await f.store.close();
    const db = new DatabaseSync(join(f.options.directory, 'prepared.sqlite'));
    try {
      if (attack === 'chunk') db.exec('UPDATE prepared_chunks SET payload=zeroblob(length(payload)) WHERE ordinal=0');
      if (attack === 'ordinal') db.exec('UPDATE prepared_chunks SET ordinal=ordinal+10');
      if (attack === 'orphan') db.exec("INSERT INTO prepared_chunks VALUES ('unowned',0,X'00')");
      if (attack === 'schema') db.exec('CREATE TABLE injected (value TEXT)');
    } finally { db.close(); }
    await expect((async () => { const s = await reopen(f.options); await s.validate(); })()).rejects.toThrow(/recovery/);
  });

  it('rolls back partial producers and capacity failures without exposing entries', async () => {
    const f = await fixture({ bytes: 1024, fileBytes: 512 });
    await expect(f.store.addFile('vault/USER.md', null, (async function* () { yield Buffer.from('partial'); throw new Error('fictional producer'); })())).rejects.toThrow('fictional producer');
    expect(f.store.summary().entries).toBe(0);
    await expect(f.store.addFile('vault/USER.md', null, bytes(Buffer.alloc(513)))).rejects.toMatchObject({ status: 413 });
    expect(f.store.summary().entries).toBe(0);
    await f.store.addFile('vault/USER.md', null, bytes('complete')); await f.store.seal();
    expect(await digest(f.store.readFile('vault/USER.md'))).toEqual({ digest: sha('complete'), bytes: 8 });
  });

  it('aborts a stuck producer, drains its transaction on close and leaves a reusable empty store', async () => {
    const f = await fixture(); let started!: () => void, finish!: (value: IteratorResult<Uint8Array>) => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const source: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]() { return { next() { started(); return new Promise(resolve => { finish = resolve; }); }, async return() { return { done: true, value: undefined }; } }; } };
    const active = f.store.addFile('vault/USER.md', null, source); const rejected = expect(active).rejects.toThrow(/cancelled/);
    await entered; await expect(f.store.addRemoval('vault/README.md', null)).rejects.toThrow(/busy/);
    await f.store.close(); await rejected; finish({ done: false, value: Buffer.from('late bytes') });
    const opened = await reopen(f.options); expect(opened.summary().entries).toBe(0);
    await opened.addFile('vault/USER.md', null, bytes('fresh')); await opened.seal();
    expect(await digest(opened.readFile('vault/USER.md'))).toEqual({ digest: sha('fresh'), bytes: 5 });
  });

  it('rejects case aliases and stale open-handle writes after another handle seals', async () => {
    const f = await fixture(), other = await reopen(f.options);
    await f.store.addFile('vault/properties/Case.md', null, bytes('one'));
    await expect(other.addFile('vault/properties/case.md', null, bytes('two'))).rejects.toThrow(/duplicate/);
    await f.store.seal(); await expect(other.addRemoval('vault/USER.md', null)).rejects.toThrow(/sealed/);
  });

  it.each(['symlink', 'hardlink', 'permissions'])('refuses %s storage', async attack => {
    const f = await fixture(); await f.store.close(); const file = join(f.options.directory, 'prepared.sqlite');
    if (attack === 'symlink') { const alias = join(f.root, 'alias'); symlinkSync(f.options.directory, alias); await expect(reopen({ ...f.options, directory: alias })).rejects.toThrow(); }
    if (attack === 'hardlink') { linkSync(file, join(f.root, 'linked.sqlite')); await expect(reopen(f.options)).rejects.toThrow(); }
    if (attack === 'permissions' && process.platform !== 'win32') { chmodSync(file, 0o644); await expect(reopen(f.options)).rejects.toThrow(); }
  });
  it('publishes a conservative storage budget from the same limits as create', () => {
    const pages = PRIVATE_BACKUP_PREPARED_LIMITS.sqliteBytes / 4096;
    const rollbackBytes = pages * (4096 + 8) + 2 * 4096 * (pages + 1) + 1024 * 1024;
    expect(preparedStorageBudget()).toEqual({
      databaseBytes: pages * 4096, rollbackBytes, totalBytes: pages * 4096 + rollbackBytes,
    });
    const tiny = preparedStorageBudget({ sqliteBytes: 65_536 });
    expect(tiny.databaseBytes).toBe(65_536);
    expect(tiny.rollbackBytes).toBe(16 * (4096 + 8) + 2 * 4096 * 17 + 1024 * 1024);
    expect(tiny.rollbackBytes).toBeGreaterThan(tiny.databaseBytes);
    expect(preparedStorageBudget({ sqliteBytes: 65_536 + 4095 }).databaseBytes).toBe(65_536);
    expect(() => preparedStorageBudget({ sqliteBytes: 65_535 })).toThrow(/limits/);
  });

  it('observes the rollback journal sector during a transaction and reopens after an interrupted write', async () => {
    const f = await fixture(); let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const source: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]() { return { next() { started(); return new Promise(() => {}); }, async return() { return { done: true, value: undefined }; } }; } };
    const active = f.store.addFile('vault/USER.md', null, source); const rejected = expect(active).rejects.toThrow(/cancelled/);
    await entered;
    const directory = f.options.directory;
    expect(readdirSync(directory).sort()).toEqual(['prepared.sqlite', 'prepared.sqlite-journal']);
    const sqlite = readFileSync(join(directory, 'prepared.sqlite'));
    const journal = readFileSync(join(directory, 'prepared.sqlite-journal'));
    const declared = preparedRollbackJournalBounds(journal);
    expect(declared.pageBytes).toBe(4096);
    expect(declared.sectorBytes).toBeGreaterThanOrEqual(512);
    expect(declared.sectorBytes).toBeLessThanOrEqual(4096);
    expect(declared.sectorBytes & (declared.sectorBytes - 1)).toBe(0);
    await f.store.close(); await rejected;
    writeFileSync(join(directory, 'prepared.sqlite'), sqlite, { mode: 0o600 });
    writeFileSync(join(directory, 'prepared.sqlite-journal'), journal, { mode: 0o600 });
    if (process.platform !== 'win32') {
      chmodSync(join(directory, 'prepared.sqlite'), 0o600);
      chmodSync(join(directory, 'prepared.sqlite-journal'), 0o600);
    }
    const opened = await reopen(f.options);
    expect(opened.summary().entries).toBe(0);
    await opened.addFile('vault/USER.md', null, bytes('fresh'));
    expect(opened.summary().entries).toBe(1);
  });

  it('refuses an unsupported rollback journal sector', () => {
    const header = Buffer.alloc(28);
    header.writeUInt32BE(4096, 24); header.writeUInt32BE(4096, 20);
    expect(preparedRollbackJournalBounds(header)).toEqual({ pageBytes: 4096, sectorBytes: 4096 });
    header.writeUInt32BE(512, 20);
    expect(preparedRollbackJournalBounds(header).sectorBytes).toBe(512);
    header.writeUInt32BE(8192, 20);
    try { preparedRollbackJournalBounds(header); throw new Error('expected refusal'); }
    catch (error) { expect(error).toMatchObject({ status: 503, message: expect.stringMatching(/unsupported filesystem/) }); }
    header.writeUInt32BE(768, 20);
    expect(() => preparedRollbackJournalBounds(header)).toThrow(/unsupported filesystem/);
    header.writeUInt32BE(4096, 20); header.writeUInt32BE(512, 24);
    expect(() => preparedRollbackJournalBounds(header)).toThrow(/unsupported filesystem/);
    expect(() => preparedRollbackJournalBounds(Buffer.alloc(27))).toThrow(/unsupported filesystem/);
  });

  it('rolls back header priming so a refused write leaves current source bytes unchanged', async () => {
    const f = await fixture();
    await f.store.addFile('vault/USER.md', null, bytes('keep'));
    const path = join(f.options.directory, 'prepared.sqlite');
    const before = readFileSync(path);
    await expect(f.store.addFile('vault/README.md', null, (async function* () { throw new Error('fictional producer'); })())).rejects.toThrow('fictional producer');
    expect(readFileSync(path)).toEqual(before);
    expect(f.store.summary()).toMatchObject({ entries: 1, bytes: 4 });
  });

  it('returns 413 when SQLite reaches the main page ceiling', async () => {
    const f = await fixture({ sqliteBytes: 65_536 });
    let error: unknown;
    for (let i = 0; i < 16 && !error; i++) {
      try { await f.store.addFile(`vault/properties/${i}.md`, null, bytes(Buffer.alloc(8_000, i))); }
      catch (caught) { error = caught; }
    }
    expect(error).toMatchObject({ status: 413, message: expect.stringMatching(/capacity/) });
    const entries = f.store.summary().entries;
    await f.store.addRemoval('vault/USER.md', null);
    expect(f.store.summary().entries).toBe(entries + 1); // A smaller transaction still fits after the failed large write.
  });

  it('does not reject a rollback journal that exceeds the store main ceiling', async () => {
    const f = await fixture({ sqliteBytes: 65_536 });
    const budget = preparedStorageBudget({ sqliteBytes: 65_536 });
    await f.store.close();
    const journal = join(f.options.directory, 'prepared.sqlite-journal');
    writeFileSync(journal, Buffer.alloc(budget.databaseBytes + 1), { mode: 0o600 });
    if (process.platform !== 'win32') chmodSync(journal, 0o600);
    const opened = await reopen(f.options);
    expect(opened.summary().entries).toBe(0);
    await opened.addFile('vault/USER.md', null, bytes('ok'));
    expect(opened.summary().entries).toBe(1);
  });

  describe('one protected TRUNCATE journal', () => {
    const journalOf = (directory: string) => join(directory, 'prepared.sqlite-journal');
    const identity = (path: string) => { const stat = statSync(path); return { ino: stat.ino, size: stat.size }; };
    // A real crash: another process changes stored ciphertext in a transaction
    // small enough in cache to spill to the database file, then dies before COMMIT.
    function crashMidTransaction(directory: string, mode: 'TRUNCATE' | 'DELETE') {
      const script = `const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.env.PREPARED_DB);
        db.exec('PRAGMA journal_mode=${mode}; PRAGMA synchronous=FULL; PRAGMA cache_size=10; BEGIN IMMEDIATE;');
        db.exec('UPDATE prepared_chunks SET payload=zeroblob(length(payload))'); process.kill(process.pid, 'SIGKILL');`;
      const result = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, PREPARED_DB: join(directory, 'prepared.sqlite') }, encoding: 'utf8' });
      // Windows has no signals: a self-kill is TerminateProcess with exit code 1
      // and no uncaught-error stack.
      if (process.platform === 'win32') { expect(result.status).toBe(1); expect(result.stderr).not.toMatch(/^\s+at /m); }
      else expect(result.signal).toBe('SIGKILL');
    }
    async function sealedWithFile(content: Buffer) {
      const f = await fixture(); await f.store.addFile('vault/properties/crash.md', null, bytes(content)); await f.store.seal(); await f.store.close(); return f;
    }
    async function readBack(store: PrivateBackupPreparedStore) { const parts: Buffer[] = []; for await (const part of store.readFile('vault/properties/crash.md')) parts.push(Buffer.from(part)); return Buffer.concat(parts); }

    it('creates the journal empty with the store and keeps that same empty file across commits and reopening', async () => {
      const f = await fixture(), journal = journalOf(f.options.directory), created = identity(journal);
      expect(created.size).toBe(0);
      await f.store.addFile('vault/USER.md', null, bytes('fictional')); await f.store.seal();
      expect(identity(journal)).toEqual(created);
      await f.store.close(); const opened = await reopen(f.options); await opened.validate();
      expect(identity(journal)).toEqual(created);
    });

    it('treats a crashed transaction\u2019s journal as hot and restores the sealed bytes, then keeps an empty journal', async () => {
      const content = randomBytes(3 * CHUNK + 11), f = await sealedWithFile(content), database = join(f.options.directory, 'prepared.sqlite');
      const before = readFileSync(database);
      crashMidTransaction(f.options.directory, 'TRUNCATE');
      const journal = readFileSync(journalOf(f.options.directory));
      expect(journal.length).toBeGreaterThanOrEqual(28); expect(preparedRollbackJournalBounds(journal).pageBytes).toBe(4096);
      expect(readFileSync(database).equals(before)).toBe(false);
      const opened = await reopen(f.options);
      expect((await opened.validate()).entries).toBe(1);
      expect(await readBack(opened)).toEqual(content);
      expect(statSync(journalOf(f.options.directory)).size).toBe(0);
    }, 30_000);

    it('refuses a journal too short to hold a header as damage and preserves it', async () => {
      const f = await fixture(); await f.store.close();
      const journal = journalOf(f.options.directory), damaged = Buffer.from('fictional!');
      writeFileSync(journal, damaged);
      await expect(reopen(f.options)).rejects.toThrow(/needs recovery/);
      expect(readFileSync(journal)).toEqual(damaged);
      writeFileSync(journal, Buffer.alloc(0));
      expect((await reopen(f.options)).summary().entries).toBe(0);
    });

    it('opens an older DELETE-mode store without a journal and moves it to a new empty journal without losing data', async () => {
      const content = randomBytes(CHUNK + 5), f = await sealedWithFile(content);
      unlinkSync(journalOf(f.options.directory));
      const opened = await reopen(f.options);
      expect(statSync(journalOf(f.options.directory)).size).toBe(0);
      expect((await opened.validate()).entries).toBe(1); expect(await readBack(opened)).toEqual(content);
    });

    it('recovers an older build\u2019s DELETE-mode hot journal, then keeps an empty journal', async () => {
      const content = randomBytes(3 * CHUNK + 7), f = await sealedWithFile(content);
      unlinkSync(journalOf(f.options.directory));
      const database = join(f.options.directory, 'prepared.sqlite'), before = readFileSync(database);
      crashMidTransaction(f.options.directory, 'DELETE');
      expect(statSync(journalOf(f.options.directory)).size).toBeGreaterThanOrEqual(28);
      expect(readFileSync(database).equals(before)).toBe(false);
      if (process.platform === 'win32') {
        // An older build's DELETE-mode journal was created by SQLite with an
        // inherited descriptor. An existing journal is verify-only, so Windows
        // holds the store for recovery and leaves both files untouched.
        const dirty = readFileSync(database), hot = readFileSync(journalOf(f.options.directory));
        await expect(reopen(f.options)).rejects.toMatchObject({ name: 'WindowsFilePrivacyError', category: 'inheritance-not-protected' });
        expect(readFileSync(database)).toEqual(dirty); expect(readFileSync(journalOf(f.options.directory))).toEqual(hot);
        return;
      }
      const opened = await reopen(f.options);
      expect((await opened.validate()).entries).toBe(1); expect(await readBack(opened)).toEqual(content);
      expect(existsSync(journalOf(f.options.directory))).toBe(true);
      expect(statSync(journalOf(f.options.directory)).size).toBe(0);
    }, 30_000);
  });
});
