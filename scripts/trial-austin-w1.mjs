// W1 first pass over a REAL customer folder, outside the repo. Prints ONLY
// counts; per-row detail (which contains customer data) is written only into
// that folder. Never copy its output files into the repo, fixtures or receipts.
//
// Node 24+:
//   REALBUD_REAL_DATA_DIR=/path/outside/repo node scripts/trial-austin-w1.mjs
// The folder holds Property.csv (CODE, Street, Suburb, ...), the ANZ export
// (ANZ*.csv), optionally an REI Tenants export (*tenant*.csv) and optionally
// w1-expected.json: one entry per bank row, the expected property code, "" for
// not rent, or "EXC" for a row a person must decide.
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBankReferenceBatch, parseBankCsv, reviewBankReferences, tenantDirectoryRules } from '../server/bank-reference.ts';
import { bankFirstPass } from '../server/bank-reference-match.ts';

const repo = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const dir = realpathSync(process.env.REALBUD_REAL_DATA_DIR || '/private/tmp/claude-501/-Users-yo-da-projects-RealBud/04066079-c8d8-44dd-aebb-92f8a9d506ed/scratchpad/austin-real');
const inside = relative(repo, dir);
if (!inside || (!inside.startsWith('..') && !isAbsolute(inside))) { console.error('Refusing: the real data folder is inside the repository.'); process.exit(1); }

const files = readdirSync(dir);
const pick = pattern => files.filter(name => pattern.test(name)).sort().at(-1);
const anzName = pick(/^ANZ.*\.csv$/i), tenantName = pick(/tenant.*\.csv$/i);
if (!anzName || !files.includes('Property.csv')) { console.error('Needs Property.csv and an ANZ*.csv export in the data folder.'); process.exit(1); }

// Property.csv: code + street (+ suburb) rules, the fallback directory.
const fallback = parseBankCsv(readFileSync(join(dir, 'Property.csv'), 'utf8')).slice(1).map(({ cells: [code, street = '', suburb = ''] }) => {
  const aliases = [street, suburb ? `${street} ${suburb}` : ''].map(s => s.trim()).filter(s => s.replace(/[^\p{L}\p{N}]/gu, '').length >= 3);
  return { propertyId: code.trim(), reference: code.trim(), aliases: [...new Set(aliases)] };
}).filter(rule => rule.propertyId);
const rules = tenantName ? tenantDirectoryRules(readFileSync(join(dir, tenantName), 'utf8'), fallback) : fallback;

const bytes = readFileSync(join(dir, anzName));
const batch = createBankReferenceBatch({ source: { filename: 'anz.csv', bytesBase64: bytes.toString('base64') }, columns: { date: '', amount: '', narrative: '', reference: '' }, dateFormat: 'DD/MM/YYYY', rules });
const pass = bankFirstPass(batch);
if (!pass) { console.error('The bank file is not an ANZ export.'); process.exit(1); }

// Reasons as categories only: the reason text itself may carry references.
const category = reason => [
  [/^Paid \$/, 'amount differs from rent'], [/^Several payers/, 'several payers (shared rent?)'], [/^The last column names/, 'last two columns differ'],
  [/matches more than one/, 'ambiguous reference'], [/^Unknown reference/, 'unknown reference'], [/^No reference/, 'no reference'],
  [/^Only an address/, 'address only'], [/^Not recognised as tenant rent/, 'business or payment-service transfer'], [/^Invoice/, 'invoice'],
  [/^Outgoing/, 'outgoing payment'], [/^Airbnb/, 'Airbnb payout'], [/^Bond/, 'bond from the RTA'], [/^Held from/, 'held from an earlier pull'],
].find(([pattern]) => pattern.test(reason))?.[1] ?? 'other';
const tally = (rows, key) => rows.reduce((acc, row) => ({ ...acc, [key(row)]: (acc[key(row)] ?? 0) + 1 }), {});
const held = pass.rows.filter(row => row.disposition === 'hold');
const counts = {
  directory: { source: tenantName ? 'tenant list + Property.csv fallback' : 'Property.csv only', rules: rules.length, tenantRules: rules.filter(rule => rule.tenant).length },
  summary: pass.summary,
  held: held.length,
  exceptionsByReason: tally(pass.rows.filter(row => row.class !== 'matched'), row => category(row.reason)),
  payerNameSuggestions: pass.rows.filter(row => row.suggestion?.startsWith('Matched by payer name')).length,
};

const detail = pass.rows.map((row, index) => `${index + 1}\t${row.amount}\t${row.class}\t${row.disposition}\t${row.propertyId ?? '-'}\t${row.reason}${row.suggestion ? ` | ${row.suggestion}` : ''}`);
const expectedPath = join(dir, 'w1-expected.json');
if (existsSync(expectedPath)) {
  const expected = JSON.parse(readFileSync(expectedPath, 'utf8'));
  if (!Array.isArray(expected) || expected.length !== pass.rows.length) { console.error('w1-expected.json needs one entry per bank row.'); process.exit(1); }
  const verdicts = pass.rows.map((row, index) => {
    const want = expected[index], rule = rules.find(item => item.propertyId === row.propertyId);
    if (row.class === 'matched') return want === row.propertyId || want === rule?.reference ? 'correct' : 'wrong';
    return want === '' || want === 'EXC' ? 'heldCorrectly' : 'heldShouldMatch';
  });
  counts.vsExpected = tally(verdicts.map(verdict => ({ verdict })), row => row.verdict);
  verdicts.forEach((verdict, index) => { detail[index] += `\texpected=${expected[index] || 'blank'}\t${verdict}`; });
}

// Byte check: import the first-pass matches; only the last column may change.
const review = reviewBankReferences(batch, pass.rows.map(row => row.disposition === 'import'
  ? { rowId: row.rowId, action: 'import', propertyId: row.propertyId, reason: row.reason } : { rowId: row.rowId, action: row.disposition, reason: row.reason }));
const before = parseBankCsv(bytes.toString('utf8')), after = parseBankCsv(review.csv);
counts.bytes = { lastColumnChanges: review.changes.length,
  otherCellsChanged: before.reduce((n, row, r) => n + row.cells.filter((cell, c) => c !== 7 && cell !== after[r].cells[c]).length, 0), rows: after.length - 1 };

writeFileSync(join(dir, 'w1-trial-detail.txt'), `${detail.join('\n')}\n`);
writeFileSync(join(dir, 'w1-trial-reviewed.csv'), review.csv);
console.log(JSON.stringify(counts, null, 2));
console.log('Per-row detail and the reviewed CSV were written to the data folder only.');
