// W2 trial over a REAL customer Property.csv, outside the repo. Imports the rate
// and levy numbers into a throwaway data folder and prints ONLY counts. Never
// copy its output into the repo, fixtures or receipts.
//
// Node 24+:
//   REALBUD_REAL_DATA_DIR=/path/outside/repo node scripts/trial-austin-w2.mjs
// The trial has no Desk, so each CSV row with a CODE stands in as a Desk
// property with that code (rows without a CODE stay held, as they would be).
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const outside = path => { const r = relative(repo, realpathSync(path)); return r.startsWith('..') || isAbsolute(r); };
const dir = process.env.REALBUD_REAL_DATA_DIR || '/private/tmp/claude-501/-Users-yo-da-projects-RealBud/04066079-c8d8-44dd-aebb-92f8a9d506ed/scratchpad/austin-real';
if (!outside(dir)) { console.error('Refusing: the real data folder is inside the repository.'); process.exit(1); }
const work = mkdtempSync(join(tmpdir(), 'realbud-trial-w2-'));
if (!outside(work)) { console.error('Refusing: the temporary data folder is inside the repository.'); process.exit(1); }
process.env.REALBUD_DATA_DIR = work;

try {
  const { parseCsvTable } = await import('../server/csv-ledger.ts');
  const { createPropertyReferenceApi, createPropertyReferenceStore, matchBillReference } = await import('../server/property-bill-references.ts');
  const csv = readFileSync(join(dir, 'Property.csv'), 'utf8');
  const [head, ...rows] = parseCsvTable(csv);
  const at = name => head.findIndex(h => h.toLowerCase().replace(/[^a-z]/g, '') === name);
  const code = at('code'), street = at('street'), suburb = at('suburb');
  const properties = rows.filter(r => (r[code] ?? '').trim()).map((r, i) => ({ id: `trial-${i}`, propertyCode: r[code].trim(), address: `${(r[street] ?? '').trim()}, ${(r[suburb] ?? '').trim()}` }));
  const store = createPropertyReferenceStore({ file: join(work, 'property-bill-references.json') });
  const api = createPropertyReferenceApi({ store, properties: () => properties, recovery: () => false });
  const { body: view } = await api('/api/bill-references', 'PUT', { csv, expectedRevision: 0 });

  const tally = (list, key) => list.reduce((acc, item) => ({ ...acc, [key(item)]: (acc[key(item)] ?? 0) + 1 }), {});
  const refs = view.entries.flatMap(e => e.refs);
  // Self-check: each imported number, written as in the sheet, finds its property.
  const selfMatch = tally(refs, r => { const m = matchBillReference(view.entries, `Notice reference ${r.raw}`); return m.state; });
  const months = ['', 'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  console.log(JSON.stringify({
    csvRows: rows.length,
    properties: view.counts.properties,
    refsByKind: view.counts.refs,
    refsWithSpaces: refs.filter(r => /\s/.test(r.raw)).length,
    refsShorterThan6Digits: refs.filter(r => r.digits.length < 6).length,
    multiRefCells: view.entries.reduce((n, e) => n + ['council', 'water', 'levy'].filter(k => e.refs.filter(r => r.kind === k).length > 1).length, 0),
    rejectedByReason: tally(view.rejected, r => r.reason),
    rejectedByKind: tally(view.rejected, r => r.kind),
    shared: view.counts.shared,
    sharedByKind: tally(view.shared, s => s.kind),
    held: view.counts.held,
    heldByReason: tally(view.held, h => h.reason),
    reiObservations: view.entries.filter(e => e.rei).length,
    reiStatus: tally(view.entries.filter(e => e.rei?.status), e => e.rei.status),
    reiPeriodUnread: rows.filter(r => (r[at('lastofperiod')] ?? '').trim()).length - view.entries.filter(e => e.rei?.period).length,
    lastPeriodByMonth: tally(view.entries.filter(e => e.rei?.period), e => months[Number(e.rei.period.slice(5))]),
    suggestedPatterns: view.suggestions.length,
    suggestedByKind: tally(view.suggestions, s => s.kind),
    suggestedNextAroundByMonth: tally(view.suggestions, s => s.nextAround),
    selfMatch,
  }, null, 2));
} finally {
  rmSync(work, { recursive: true, force: true });
}
