import { join } from 'node:path';
import { DATA_DIR } from './config.ts';
import { parseCsvTable } from './csv-ledger.ts';
import { readPrivateJsonWithFallback, writePrivateJson } from './private-json.ts';
import { redactSecretsInText } from './redact.ts';
import { matchSender, normalizeSupplierEmail, normalizeSupplierRows, readSupplierDirectory, supplierEmailConflicts,
  type SupplierDirectory, type SupplierEmailConflict, type SupplierRejection } from '../shared/supplier-directory.ts';

/** The office's supplier directory for W4 sender checks. Private JSON (0600,
 * temp → fsync → rename); a damaged file holds every change and is never
 * replaced. Every change carries the caller's `expectedRevision`. */
const MAX_BYTES = 2_000_000;
const fail = (message: string, status: number, extra: object = {}): never => { throw Object.assign(new Error(message), { status }, extra); };
const recovery = (): never => fail('The saved supplier directory needs recovery. Its file has been kept.', 503);
const validate = (value: unknown) => { try { return readSupplierDirectory(value); } catch { return recovery(); } };
const empty = (): SupplierDirectory => ({ version: 1, purpose: 'supplier-directory', revision: 0, importedAt: null, suppliers: [], aliases: [], rejected: [] });

export function createSupplierDirectory(options: { file?: string; now?: () => number } = {}) {
  const file = options.file ?? join(DATA_DIR, 'supplier-directory.json');
  const now = options.now ?? Date.now;
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => { const next = queue.then(work, work); queue = next.catch(() => {}); return next; };
  const load = async (): Promise<SupplierDirectory> => {
    let raw: unknown;
    try { raw = await readPrivateJsonWithFallback(file, MAX_BYTES, validate); } catch { return recovery(); }
    return raw === undefined ? empty() : validate(raw);
  };
  /** Loads and checks the caller's revision inside the queue. */
  const current = async (expectedRevision: unknown) => {
    if (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0) fail('Reload the supplier directory before changing it.', 400);
    const directory = await load();
    if (directory.revision !== expectedRevision) fail('The supplier directory changed since you opened it. Reload it and try again.', 409);
    return directory;
  };
  const save = async (directory: SupplierDirectory) => {
    directory.revision++;
    await writePrivateJson(file, directory, { maxBytes: MAX_BYTES, validate, keepPrevious: true });
    return structuredClone(directory);
  };
  return {
    read: (): Promise<SupplierDirectory> => serial(load),

    /** Replaces the imported suppliers with the REI Cloud Suppliers CSV.
     * Reviewer aliases are kept. A list with no usable row changes nothing. */
    importCsv: (input: { csv: string; expectedRevision: number }): Promise<{ directory: SupplierDirectory; rejected: SupplierRejection[]; conflicts: SupplierEmailConflict[] }> => serial(async () => {
      if (typeof input.csv !== 'string') fail('Choose the supplier list CSV to import.', 400);
      let parsed: ReturnType<typeof normalizeSupplierRows>;
      try { parsed = normalizeSupplierRows(parseCsvTable(input.csv)); }
      catch (error) { return fail(error instanceof Error && error.message !== 'csv has an unclosed quote' ? error.message : 'The supplier list CSV could not be read. Export it again and retry.', 400); }
      const rejected = parsed.rejected.map(r => ({ row: r.row, reason: redactSecretsInText(r.reason) }));
      if (!parsed.suppliers.length) fail('No supplier rows could be imported. The saved directory is unchanged.', 400, { rejected });
      const directory = await current(input.expectedRevision);
      directory.suppliers = parsed.suppliers.map(s => ({ ...s, description: redactSecretsInText(s.description) }));
      directory.rejected = rejected;
      directory.importedAt = Math.max(0, now());
      const saved = await save(directory);
      return { directory: saved, rejected, conflicts: supplierEmailConflicts(saved) };
    }),

    /** A reviewer approves one more sending address for a listed supplier. */
    addAlias: (input: { reference: string; email: string; expectedRevision: number }): Promise<SupplierDirectory> => serial(async () => {
      const email = typeof input.email === 'string' ? normalizeSupplierEmail(input.email) : null;
      if (!email) fail('Enter a valid email address for the supplier.', 400);
      const directory = await current(input.expectedRevision);
      if (!directory.suppliers.some(s => s.reference === input.reference)) fail('That supplier is not in the directory. Reload it and try again.', 404);
      const match = matchSender(directory, email!);
      if (match.kind === 'listed' && match.supplierRef === input.reference) fail('That email is already approved for this supplier.', 409);
      if (match.kind !== 'unlisted') fail(`That email already belongs to ${match.kind === 'listed' ? `supplier ${match.supplierRef}` : 'more than one supplier'}. Correct the supplier list first.`, 409);
      directory.aliases.push({ reference: input.reference, email: email!, addedAt: Math.max(0, now()) });
      return save(directory);
    }),

    removeAlias: (input: { reference: string; email: string; expectedRevision: number }): Promise<SupplierDirectory> => serial(async () => {
      const email = typeof input.email === 'string' ? normalizeSupplierEmail(input.email) : null;
      const directory = await current(input.expectedRevision);
      const kept = directory.aliases.filter(a => !(a.reference === input.reference && a.email === email));
      if (kept.length === directory.aliases.length) fail('That approved email is no longer in the directory. Reload it and try again.', 404);
      directory.aliases = kept;
      return save(directory);
    }),
  };
}
