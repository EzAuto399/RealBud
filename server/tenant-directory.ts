// The office's REI tenant directory for W1: each tenant's REI Reference (what
// goes in the bank file's last column), Property, names, rent and BPay/Ref No.,
// saved from REI's Tenants list. A revisioned record in the encrypted workflow
// database (the same store as the bank reviews, so BankReferenceStore can read
// it synchronously as every new batch's default directory). Idiom of
// server/inspection-rules.ts: every change carries the caller's
// `expectedRevision`, an unchanged list writes nothing, the last 10 replaced
// versions are kept, and a damaged record holds every change. Only the columns
// the bank match uses are kept; arrears and owner columns are never stored.
import { createHash } from 'node:crypto';
import { tenantDirectoryRules } from './bank-reference.ts';
import { parseCsvTable } from './csv-ledger.ts';
import type { WorkflowDatabase } from './workflow-database.ts';

export interface TenantEntry { reference: string; surname: string; firstname: string; property: string; rent: string; bpay: string }
export interface TenantRejection { row: number; reason: string }
export interface TenantSource { name: string; sha256: string; rows: number }
export interface TenantDirectory {
  version: 1; purpose: 'tenant-directory'; savedAt: number; source: TenantSource; tenants: TenantEntry[];
  history: Array<{ savedAt: number; source: TenantSource; tenants: TenantEntry[] }>;
}

export const MAX_TENANTS = 2000; // createBankReferenceBatch takes at most 2,000 rules.
export const MAX_TENANT_HISTORY = 10;
const KIND = 'tenant-directory', ID = 'tenant-directory:office';
// When a complete REI read last showed the saved list (even unchanged). A sibling record, so a check adds no revision to the
// list (a preview's expectedRevision stays valid) and records saved before it existed load as they are.
const CHECK_KIND = 'tenant-directory-check', CHECK_ID = 'tenant-directory-check:office';
/** The content hash of a tenant list: what a bank batch records it was built from. */
export const tenantListHash = (tenants: readonly TenantEntry[]) => createHash('sha256').update(JSON.stringify(tenants)).digest('hex');
const FIELDS = ['reference', 'surname', 'firstname', 'property', 'rent', 'bpay'] as const;
const LIMIT: Record<keyof TenantEntry, number> = { reference: 100, surname: 100, firstname: 100, property: 100, rent: 50, bpay: 50 };
const fail = (message: string, status: number): never => { throw Object.assign(new Error(message), { status }); };
const recovery = (): never => fail('The saved REI tenant list needs recovery. It has been kept and nothing was changed.', 503);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string) => Object.keys(v).sort().join(',') === keys.split(',').sort().join(',');
const clean = (v: string) => v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
const formula = (v: string) => /^[=+@-]/.test(v);
const key = (h: string) => h.toLowerCase().replace(/[^a-z]/g, '');
// The same header names tenantDirectoryRules (server/bank-reference.ts) reads.
const HEADERS: Record<keyof TenantEntry, (h: string) => boolean> = {
  reference: h => ['reference', 'tenantreference', 'ref'].includes(h), property: h => ['property', 'propertycode', 'code'].includes(h),
  surname: h => ['surname', 'lastname'].includes(h), firstname: h => ['firstname', 'givenname'].includes(h),
  rent: h => ['rent', 'rentamount'].includes(h), bpay: h => h.startsWith('bpay') || h === 'refno',
};

/** REI's Tenants export (header row first, columns in any order) → tenants. Nothing is
 * dropped silently: a row without a Reference or Property, with an unusable Reference, or
 * repeating an earlier Reference is rejected with a reason. Throws a sentence for a list that
 * cannot be read at all. */
export function normalizeTenantRows(table: string[][]): { tenants: TenantEntry[]; rejected: TenantRejection[] } {
  const [header, ...rows] = table;
  if (!header) throw new Error('The tenant list is empty. Export the Tenants list from REI again.');
  const at = Object.fromEntries(FIELDS.map(field => [field, header.findIndex(h => HEADERS[field](key(h)))])) as Record<keyof TenantEntry, number>;
  if (at.reference < 0 || at.property < 0) throw new Error("The tenant list needs Reference and Property columns, as in REI's Tenants export.");
  if (rows.length > MAX_TENANTS) throw new Error(`The tenant list has more than ${MAX_TENANTS} rows. Contact support before importing it.`);
  const tenants: TenantEntry[] = [], rejected: TenantRejection[] = [], seen = new Set<string>();
  rows.forEach((cells, index) => {
    const row = index + 2; // spreadsheet numbering: the header is row 1
    const entry = Object.fromEntries(FIELDS.map(field => [field, at[field] < 0 ? '' : clean(cells[at[field]] ?? '').slice(0, LIMIT[field])])) as unknown as TenantEntry;
    const raw = clean(cells[at.reference] ?? '');
    if (!raw) return void rejected.push({ row, reason: `Row ${row} has no REI Reference.` });
    if (raw.length > LIMIT.reference || formula(raw)) return void rejected.push({ row, reason: `Row ${row}: the REI Reference is not plain text of at most ${LIMIT.reference} characters.` });
    if (!entry.property) return void rejected.push({ row, reason: `Row ${row} (${raw}) has no Property, so a payment cannot be matched to it.` });
    if (seen.has(raw)) return void rejected.push({ row, reason: `Row ${row} repeats REI Reference ${raw}; only its first row was kept.` });
    seen.add(raw); tenants.push(entry);
  });
  return { tenants, rejected };
}

const cell = (text: string) => /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
/** The saved tenants as the CSV tenantDirectoryRules reads. */
export function tenantDirectoryCsv(tenants: readonly TenantEntry[]): string {
  return ['Reference,Surname,Firstname,Property,Rent,BPay/Ref No.', ...tenants.map(t => [t.reference, t.surname, t.firstname, t.property, t.rent, t.bpay].map(cell).join(','))].join('\n') + '\n';
}

/** Reads an export's text into tenants and rejections, and proves the bank match can use them. */
export function parseTenantList(csv: string): { tenants: TenantEntry[]; rejected: TenantRejection[]; rows: number } {
  let table: string[][];
  try { table = parseCsvTable(csv); } catch { return fail("The tenant list could not be read as a CSV. Export it from REI again.", 400); }
  let parsed: ReturnType<typeof normalizeTenantRows>;
  try { parsed = normalizeTenantRows(table); } catch (error) { return fail(error instanceof Error ? error.message : 'The tenant list could not be read.', 400); }
  if (!parsed.tenants.length) fail('No tenant rows could be used. The saved tenant list is unchanged.', 400);
  try { tenantDirectoryRules(tenantDirectoryCsv(parsed.tenants)); }
  catch (error) { fail(error instanceof Error ? error.message : 'The tenant list could not be used for bank matching.', 400); }
  return { ...parsed, rows: Math.max(0, table.length - 1) };
}

const entry = (v: unknown): v is TenantEntry => object(v) && exact(v, FIELDS.join(',')) && FIELDS.every(f => typeof v[f] === 'string' && (v[f] as string).length <= LIMIT[f] && !/[\u0000-\u001f\u007f]/.test(v[f] as string));
const source = (v: unknown): v is TenantSource => object(v) && exact(v, 'name,sha256,rows') && typeof v.name === 'string' && v.name.length <= 200 &&
  typeof v.sha256 === 'string' && /^[a-f0-9]{64}$/.test(v.sha256) && Number.isSafeInteger(v.rows) && Number(v.rows) >= 0;
const list = (v: unknown) => Array.isArray(v) && v.length <= MAX_TENANTS && v.every(entry) && new Set(v.map(t => (t as TenantEntry).reference)).size === v.length;
/** Throws on anything unexpected; a damaged record is never repaired. */
export function readTenantDirectory(v: unknown): TenantDirectory {
  if (!object(v) || !exact(v, 'version,purpose,savedAt,source,tenants,history') || v.version !== 1 || v.purpose !== 'tenant-directory' ||
      !Number.isSafeInteger(v.savedAt) || !source(v.source) || !list(v.tenants) || !Array.isArray(v.history) || v.history.length > MAX_TENANT_HISTORY ||
      !v.history.every(h => object(h) && exact(h, 'savedAt,source,tenants') && Number.isSafeInteger(h.savedAt) && source(h.source) && list(h.tenants))) return recovery();
  return structuredClone(v) as unknown as TenantDirectory;
}

export function createTenantDirectoryStore(db: WorkflowDatabase, now: () => number = Date.now) {
  const load = () => {
    const record = db.get<unknown>(KIND, ID);
    return record ? { revision: record.revision, directory: readTenantDirectory(record.value) } : { revision: 0, directory: null };
  };
  return {
    /** The saved list (null before the first save) and its revision (0 before the first save). */
    read: (): { revision: number; directory: TenantDirectory | null } => load(),
    /** The saved list's hash and when REI last showed it complete: the later of its save and a check of this exact list.
     * A list never checked (or saved before checks were recorded) was last checked when it was saved. Null when none is saved. */
    freshness(): { checkedAt: number; hash: string } | null {
      const { directory } = load();
      if (!directory) return null;
      const hash = tenantListHash(directory.tenants), check = db.get<{ hash?: unknown; checkedAt?: unknown }>(CHECK_KIND, CHECK_ID)?.value;
      const checkedAt = check?.hash === hash && Number.isSafeInteger(check.checkedAt) ? Math.max(Number(check.checkedAt), directory.savedAt) : directory.savedAt;
      return { checkedAt, hash };
    },
    /** A complete REI read showed exactly these tenants: if they are the saved list, it was checked now. Returns whether it was. */
    markChecked(tenants: readonly TenantEntry[]): boolean {
      return db.transaction(() => {
        const { directory } = load();
        if (!directory || tenantListHash(directory.tenants) !== tenantListHash(tenants)) return false;
        const value = { hash: tenantListHash(tenants), checkedAt: Math.max(0, now()) };
        const existing = db.get<unknown>(CHECK_KIND, CHECK_ID);
        if (existing) db.update<unknown>(CHECK_KIND, CHECK_ID, existing.revision, () => value); else db.create<unknown>(CHECK_KIND, CHECK_ID, value, null);
        return true;
      });
    },
    /** Replaces the list. An identical list writes nothing and keeps its revision. */
    save(input: { tenants: TenantEntry[]; source: TenantSource; expectedRevision: unknown }): { revision: number; directory: TenantDirectory; saved: boolean } {
      if (!Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0) fail('Reload the tenant list before saving it.', 400);
      if (!list(input.tenants) || !input.tenants.length || !source(input.source)) fail('The tenant list to save is not valid. Refresh it from REI again.', 400);
      return db.transaction(() => {
        const current = load();
        if (current.revision !== input.expectedRevision) fail('The saved tenant list changed since this preview. Refresh from REI and try again.', 409);
        if (current.directory && JSON.stringify(current.directory.tenants) === JSON.stringify(input.tenants)) return { ...current, directory: current.directory, saved: false };
        const savedAt = Math.max(0, now());
        const next: TenantDirectory = { version: 1, purpose: 'tenant-directory', savedAt, source: structuredClone(input.source), tenants: structuredClone(input.tenants),
          history: current.directory ? [{ savedAt: current.directory.savedAt, source: current.directory.source, tenants: current.directory.tenants }, ...current.directory.history].slice(0, MAX_TENANT_HISTORY) : [] };
        const record = current.directory ? db.update<unknown>(KIND, ID, current.revision, () => next) : db.create<unknown>(KIND, ID, next, null);
        return { revision: record.revision, directory: next, saved: true };
      });
    },
  };
}
export type TenantDirectoryStore = ReturnType<typeof createTenantDirectoryStore>;

/** The saved tenant list as the CSV a new batch uses as its directory, or null when none is saved. */
export function savedTenantDirectoryCsv(db: WorkflowDatabase): string | null {
  const record = db.get<unknown>(KIND, ID);
  return record ? tenantDirectoryCsv(readTenantDirectory(record.value).tenants) : null;
}
