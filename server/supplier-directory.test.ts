import { chmod, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DATA_DIR } from './config.ts';
import { createSupplierDirectory } from './supplier-directory.ts';
import { matchSender } from '../shared/supplier-directory.ts';

let n = 0;
const fresh = () => createSupplierDirectory({ file: join(DATA_DIR, `suppliers-${++n}.json`), now: () => 1_000 });

const CSV = [
  'Reference,Description,Email',
  'FIC-PLUMB,Fictional Plumbing,"  Accounts@Fictional-Plumbing.example ; jobs@fictional-plumbing.example"',
  'FIC-ELEC,Fictional Electrical,office@fictional-electrical.example, ',
  ',No reference here,someone@fictional-none.example',
  'FIC-BAD,Bad email only,not-an-email',
  'FIC-MIX,"Mixed, Pty Ltd","mix@fictional-mix.example,broken@"',
  'FIC-DUPE,Claims plumbing address,accounts@fictional-plumbing.example',
  'FIC-ELEC,Repeated reference,other@fictional-electrical.example',
].join('\n');

describe('supplier directory', () => {
  it('imports multi-email rows and reports every unusable row and email', async () => {
    const store = fresh();
    const { directory, rejected, conflicts } = await store.importCsv({ csv: CSV, expectedRevision: 0 });
    expect(directory.revision).toBe(1);
    expect(directory.suppliers).toEqual([
      { reference: 'FIC-PLUMB', description: 'Fictional Plumbing', emails: ['accounts@fictional-plumbing.example', 'jobs@fictional-plumbing.example'] },
      { reference: 'FIC-ELEC', description: 'Fictional Electrical', emails: ['office@fictional-electrical.example'] },
      { reference: 'FIC-BAD', description: 'Bad email only', emails: [] },
      { reference: 'FIC-MIX', description: 'Mixed, Pty Ltd', emails: ['mix@fictional-mix.example'] },
      { reference: 'FIC-DUPE', description: 'Claims plumbing address', emails: ['accounts@fictional-plumbing.example'] },
    ]);
    expect(rejected.map(r => r.row)).toEqual([4, 5, 6, 8]);
    expect(rejected[0]!.reason).toBe('Row 4 has no supplier reference.');
    expect(rejected[1]!.reason).toContain('(FIC-BAD): "not-an-email" is not a valid email address');
    expect(rejected[2]!.reason).toContain('"broken@" is not a valid email address');
    expect(rejected[3]!.reason).toContain('repeats supplier reference FIC-ELEC');
    expect(conflicts).toEqual([{ email: 'accounts@fictional-plumbing.example', supplierRefs: ['FIC-DUPE', 'FIC-PLUMB'] }]);
    expect((await store.read()).rejected).toEqual(rejected);
  });

  it('matches exact normalized emails and aliases only', async () => {
    const store = fresh();
    const { directory } = await store.importCsv({ csv: CSV, expectedRevision: 0 });
    expect(matchSender(directory, '  JOBS@Fictional-Plumbing.EXAMPLE ')).toEqual({ kind: 'listed', supplierRef: 'FIC-PLUMB' });
    expect(matchSender(directory, 'accounts@fictional-plumbing.example')).toEqual({ kind: 'conflict', supplierRefs: ['FIC-DUPE', 'FIC-PLUMB'] });
    // Same domain or display-name text is never a match.
    expect(matchSender(directory, 'billing@fictional-plumbing.example')).toEqual({ kind: 'unlisted' });
    expect(matchSender(directory, 'Fictional Plumbing <jobs@fictional-plumbing.example>')).toEqual({ kind: 'unlisted' });
    expect(matchSender(directory, '')).toEqual({ kind: 'unlisted' });

    const aliased = await store.addAlias({ reference: 'FIC-ELEC', email: ' Invoices@Fictional-Sparky.example', expectedRevision: 1 });
    expect(aliased.aliases).toEqual([{ reference: 'FIC-ELEC', email: 'invoices@fictional-sparky.example', addedAt: 1_000 }]);
    expect(aliased.suppliers.find(s => s.reference === 'FIC-ELEC')!.emails).toEqual(['office@fictional-electrical.example']);
    expect(matchSender(aliased, 'invoices@fictional-sparky.example')).toEqual({ kind: 'listed', supplierRef: 'FIC-ELEC' });
    await expect(store.addAlias({ reference: 'FIC-ELEC', email: 'jobs@fictional-plumbing.example', expectedRevision: 2 })).rejects.toMatchObject({ status: 409 });

    // Re-import replaces imported emails but keeps reviewer aliases.
    const again = await store.importCsv({ csv: 'reference,description,email\nFIC-ELEC,Fictional Electrical,office@fictional-electrical.example', expectedRevision: 2 });
    expect(matchSender(again.directory, 'invoices@fictional-sparky.example')).toEqual({ kind: 'listed', supplierRef: 'FIC-ELEC' });
    expect(matchSender(again.directory, 'jobs@fictional-plumbing.example')).toEqual({ kind: 'unlisted' });
    const removed = await store.removeAlias({ reference: 'FIC-ELEC', email: 'invoices@fictional-sparky.example', expectedRevision: 3 });
    expect(matchSender(removed, 'invoices@fictional-sparky.example')).toEqual({ kind: 'unlisted' });
  });

  it('imports the REI Cloud Suppliers export: any column order, quoted cells, blank and multiple emails, shared emails as conflicts', async () => {
    const rei = [
      '\uFEFFReference,Description,Phone,Phone A/H,Mobile,Fax,E-mail,Address,Category',
      'FIC-ROOF,"Fictional Roofing, Pty Ltd",07 0000 0001,,0400 000 001,,"accounts@fictional-roofing.example; jobs@fictional-roofing.example","1 Fictional Rd, Synthetic QLD",Roofing',
      'FIC-LOCK,Fictional Locks,07 0000 0002,,,,,"2 Fictional St",Locksmith',
      'FIC-GARDEN,Fictional Gardens,,,,,"mow@fictional-gardens.example, accounts@fictional-roofing.example",,Gardening',
      '"FIC-PEST","Fictional ""Bug"" Busters",,,,,"  Pests@Fictional-Pests.example ",,Pest control',
    ].join('\r\n');
    const { directory, rejected, conflicts } = await fresh().importCsv({ csv: rei, expectedRevision: 0 });
    expect(directory.suppliers).toEqual([
      { reference: 'FIC-ROOF', description: 'Fictional Roofing, Pty Ltd', emails: ['accounts@fictional-roofing.example', 'jobs@fictional-roofing.example'] },
      { reference: 'FIC-LOCK', description: 'Fictional Locks', emails: [] },
      { reference: 'FIC-GARDEN', description: 'Fictional Gardens', emails: ['mow@fictional-gardens.example', 'accounts@fictional-roofing.example'] },
      { reference: 'FIC-PEST', description: 'Fictional "Bug" Busters', emails: ['pests@fictional-pests.example'] },
    ]);
    expect(rejected).toEqual([]);
    expect(conflicts).toEqual([{ email: 'accounts@fictional-roofing.example', supplierRefs: ['FIC-GARDEN', 'FIC-ROOF'] }]);
    expect(matchSender(directory, 'accounts@fictional-roofing.example')).toEqual({ kind: 'conflict', supplierRefs: ['FIC-GARDEN', 'FIC-ROOF'] });
    // A supplier with no email imports but never matches anything by email.
    expect(matchSender(directory, '')).toEqual({ kind: 'unlisted' });
    expect(matchSender(directory, 'locks@fictional-locks.example')).toEqual({ kind: 'unlisted' });
  });

  it('refuses a stale revision and a list with no usable rows', async () => {
    const store = fresh();
    await store.importCsv({ csv: CSV, expectedRevision: 0 });
    await expect(store.importCsv({ csv: CSV, expectedRevision: 0 })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('Reload') });
    await expect(store.importCsv({ csv: 'Reference,Email\n,nobody@fictional.example', expectedRevision: 1 }))
      .rejects.toMatchObject({ status: 400, rejected: [{ row: 2, reason: 'Row 2 has no supplier reference.' }] });
    await expect(store.importCsv({ csv: 'Name,Phone\nx,y', expectedRevision: 1 })).rejects.toMatchObject({ status: 400 });
    expect((await store.read()).revision).toBe(1);
  });

  it('writes 0600 and fails closed on a damaged file without replacing it', async () => {
    const store = createSupplierDirectory({ now: () => 1_000 });
    const file = join(DATA_DIR, 'supplier-directory.json');
    await store.importCsv({ csv: CSV, expectedRevision: 0 });
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
    await writeFile(file, '{"version":1,"purpose":"supplier-directory"');
    await chmod(file, 0o600);
    await expect(store.read()).rejects.toMatchObject({ status: 503 });
    await expect(store.importCsv({ csv: CSV, expectedRevision: 1 })).rejects.toMatchObject({ status: 503 });
    expect(await readFile(file, 'utf8')).toBe('{"version":1,"purpose":"supplier-directory"');
  });

  it('restores the last good copy when the saved file is damaged, keeping the damaged file', async () => {
    const file = join(DATA_DIR, `suppliers-${++n}.json`);
    const store = createSupplierDirectory({ file, now: () => 1_000 });
    await store.importCsv({ csv: CSV, expectedRevision: 0 });
    await store.importCsv({ csv: CSV, expectedRevision: 1 });
    await writeFile(file, '{"version":1', { mode: 0o600 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try { expect(await store.read()).toMatchObject({ revision: 1 }); } finally { warn.mockRestore(); }
    expect((await readdir(DATA_DIR)).some(name => name.startsWith(`suppliers-${n}.json.damaged-`))).toBe(true);
    expect(await store.importCsv({ csv: CSV, expectedRevision: 1 })).toMatchObject({ directory: { revision: 2 } });
  });
});
