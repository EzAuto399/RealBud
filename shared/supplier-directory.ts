/** Supplier directory for the W4 maintenance workflow: the office's REI Cloud
 * Suppliers list (reference, description, one or more emails) plus email
 * aliases a reviewer has approved. Dependency-free; the server parses the CSV
 * and persists it privately. */

export interface Supplier { reference: string; description: string; emails: string[] }
/** An extra approved email a reviewer added. Kept apart from imported emails so
 * a re-import never drops reviewer work; it only counts while its reference is
 * in the imported list. */
export interface SupplierAlias { reference: string; email: string; addedAt: number }
/** A row (or one email in a row) the import could not use, with the reason. */
export interface SupplierRejection { row: number; reason: string }
export interface SupplierEmailConflict { email: string; supplierRefs: string[] }
export interface SupplierDirectory {
  version: 1; purpose: 'supplier-directory'; revision: number; importedAt: number | null;
  suppliers: Supplier[]; aliases: SupplierAlias[]; rejected: SupplierRejection[];
}
export type SenderMatch =
  | { kind: 'listed'; supplierRef: string }
  | { kind: 'unlisted' }
  | { kind: 'conflict'; supplierRefs: string[] };

export const SUPPLIER_DIRECTORY_MAX_SUPPLIERS = 5000;
const MAX_EMAILS = 20, MAX_REFERENCE = 100, MAX_DESCRIPTION = 500, MAX_REASON = 500;

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string) => Object.keys(v).sort().join(',') === keys.split(',').sort().join(',');
const CONTROL = /[\u0000-\u001f\u007f]/;
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && !CONTROL.test(v);
const count = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const clean = (v: string) => v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
const EMAIL = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>".]+$/;

/** Trimmed, lowercased address, or null when it is not shaped like one. */
export function normalizeSupplierEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  return email.length <= 254 && EMAIL.test(email) ? email : null;
}

const headerKey = (h: string) => h.toLowerCase().replace(/[\s_-]+/g, '');
const HEADERS = {
  reference: ['reference', 'ref', 'supplierreference', 'supplierref', 'code'],
  description: ['description', 'name', 'suppliername'],
  email: ['email', 'emails', 'emailaddress', 'emailaddresses', 'mail'],
};

/** Turns a parsed CSV table (header row first, e.g. the REI Cloud Suppliers
 * export: Reference, Description, Phone, …, Email, Address, Category in any
 * order) into suppliers. Nothing is dropped silently: a row without a
 * reference or repeating an earlier reference is rejected with a reason, and so
 * is each unusable email. A supplier with no usable email is still imported; it
 * can never match a sender by email. Throws a sentence for a list that cannot
 * be read at all. */
export function normalizeSupplierRows(table: string[][]): { suppliers: Supplier[]; rejected: SupplierRejection[] } {
  const [header, ...rows] = table;
  if (!header) throw new Error('The supplier list is empty. Export the Suppliers list from REI Cloud and try again.');
  const column = (names: string[]) => header.findIndex(h => names.includes(headerKey(h)));
  const ref = column(HEADERS.reference), desc = column(HEADERS.description), mail = column(HEADERS.email);
  if (ref < 0 || mail < 0) throw new Error('The supplier list needs a Reference column and an Email column.');
  if (rows.length > SUPPLIER_DIRECTORY_MAX_SUPPLIERS) throw new Error(`The supplier list has more than ${SUPPLIER_DIRECTORY_MAX_SUPPLIERS} rows. Split it or contact support.`);
  const suppliers: Supplier[] = [], rejected: SupplierRejection[] = [], seen = new Set<string>();
  rows.forEach((cells, index) => {
    const row = index + 2; // spreadsheet numbering: the header is row 1
    const reference = clean(cells[ref] ?? '');
    if (!reference) return void rejected.push({ row, reason: `Row ${row} has no supplier reference.` });
    if (reference.length > MAX_REFERENCE) return void rejected.push({ row, reason: `Row ${row} has a supplier reference longer than ${MAX_REFERENCE} characters.` });
    if (seen.has(reference)) return void rejected.push({ row, reason: `Row ${row} repeats supplier reference ${reference}; only its first row was kept.` });
    const emails: string[] = [];
    for (const part of (cells[mail] ?? '').split(/[;,]/)) {
      if (!part.trim()) continue;
      const email = normalizeSupplierEmail(part);
      if (!email) rejected.push({ row, reason: `Row ${row} (${reference}): "${clean(part).slice(0, 80)}" is not a valid email address.` });
      else if (!emails.includes(email)) emails.push(email);
    }
    if (emails.length > MAX_EMAILS) return void rejected.push({ row, reason: `Row ${row} (${reference}) has more than ${MAX_EMAILS} email addresses.` });
    seen.add(reference);
    suppliers.push({ reference, description: desc < 0 ? '' : clean(cells[desc] ?? '').slice(0, MAX_DESCRIPTION), emails });
  });
  return { suppliers, rejected };
}

/** Every supplier reference an address belongs to, by imported email or by an
 * alias whose reference is still listed. */
function owners(directory: Pick<SupplierDirectory, 'suppliers' | 'aliases'>, email: string): string[] {
  const refs = new Set(directory.suppliers.filter(s => s.emails.includes(email)).map(s => s.reference));
  const listed = new Set(directory.suppliers.map(s => s.reference));
  for (const a of directory.aliases) if (a.email === email && listed.has(a.reference)) refs.add(a.reference);
  return [...refs].sort();
}

/** Addresses claimed by more than one supplier. Each one blocks matching for
 * that address until the list or the aliases are corrected. */
export function supplierEmailConflicts(directory: Pick<SupplierDirectory, 'suppliers' | 'aliases'>): SupplierEmailConflict[] {
  const emails = new Set([...directory.suppliers.flatMap(s => s.emails), ...directory.aliases.map(a => a.email)]);
  return [...emails].sort().map(email => ({ email, supplierRefs: owners(directory, email) })).filter(c => c.supplierRefs.length > 1);
}

/** Directory lookup for an invoice sender: exact normalized email or accepted
 * alias only, never display name or shared domain. A `listed` result means the
 * address is in the supplier directory, not that the charge is valid. An address
 * claimed by two suppliers is a `conflict`, never resolved by picking one. */
export function matchSender(directory: Pick<SupplierDirectory, 'suppliers' | 'aliases'>, email: string): SenderMatch {
  const normalized = normalizeSupplierEmail(email);
  if (!normalized) return { kind: 'unlisted' };
  const refs = owners(directory, normalized);
  if (refs.length === 1) return { kind: 'listed', supplierRef: refs[0]! };
  return refs.length ? { kind: 'conflict', supplierRefs: refs } : { kind: 'unlisted' };
}

const validEmail = (v: unknown): v is string => typeof v === 'string' && normalizeSupplierEmail(v) === v;

/** Throws on anything unexpected; a damaged directory is never repaired. */
export function readSupplierDirectory(v: unknown): SupplierDirectory {
  const bad = (): never => { throw new Error('The saved supplier directory needs recovery. Its file has been kept.'); };
  if (!object(v) || !exact(v, 'version,purpose,revision,importedAt,suppliers,aliases,rejected') || v.version !== 1 ||
      v.purpose !== 'supplier-directory' || !count(v.revision) || !(v.importedAt === null || count(v.importedAt)) ||
      !Array.isArray(v.suppliers) || v.suppliers.length > SUPPLIER_DIRECTORY_MAX_SUPPLIERS ||
      !Array.isArray(v.aliases) || v.aliases.length > SUPPLIER_DIRECTORY_MAX_SUPPLIERS ||
      !Array.isArray(v.rejected) || v.rejected.length > SUPPLIER_DIRECTORY_MAX_SUPPLIERS * (MAX_EMAILS + 1)) return bad();
  const refs = new Set<string>();
  for (const s of v.suppliers) {
    if (!object(s) || !exact(s, 'reference,description,emails') || !text(s.reference, MAX_REFERENCE) || !s.reference || s.reference !== s.reference.trim() ||
        refs.has(s.reference) || !text(s.description, MAX_DESCRIPTION) || !Array.isArray(s.emails) ||
        s.emails.length > MAX_EMAILS || !s.emails.every(validEmail) || new Set(s.emails).size !== s.emails.length) return bad();
    refs.add(s.reference);
  }
  for (const a of v.aliases) if (!object(a) || !exact(a, 'reference,email,addedAt') || !text(a.reference, MAX_REFERENCE) || !a.reference ||
      !validEmail(a.email) || !count(a.addedAt)) return bad();
  for (const r of v.rejected) if (!object(r) || !exact(r, 'row,reason') || !count(r.row) || !text(r.reason, MAX_REASON)) return bad();
  return structuredClone(v) as unknown as SupplierDirectory;
}
