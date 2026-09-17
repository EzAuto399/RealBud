#!/usr/bin/env node
// A real Hermes turn over explicitly selected, synthetic Office documents.
// No fixture facts or reference are supplied in the model prompt. This is
// local worker proof, not managed company access or second-device proof.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';

const fixtures = resolve(process.argv[2] || 'outputs/realbud-device-workflows-2026-09-14/fixtures');
const report = resolve(process.argv[3] || 'outputs/realbud-device-workflows-2026-09-14/selected-documents-live.json');
const names = ['Maintenance summary.docx', 'Accounts quotes.xlsx'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const source = names.map(name => ({ name, bytes: readFileSync(join(fixtures, name)) }));
const before = source.map(file => digest(file.bytes));
const expected = JSON.parse(readFileSync(join(fixtures, 'expected.json'), 'utf8'));
process.env.REALBUD_HERMES_HOME = (await import('../server/hermes-paths.ts')).hermesHome();
const scratch = mkdtempSync(join(tmpdir(), 'realbud-selected-documents-'));
process.env.REALBUD_DATA_DIR = scratch;
const result = { startedAt: new Date().toISOString(), layer: 'real-local-Hermes-with-synthetic-files', ok: false, originalsUnchanged: false };
try {
  const { saveAskAttachment } = await import('../server/ask-attach.ts');
  const { executeRecipeJob } = await import('../server/job-executor.ts');
  const { JobRunStore } = await import('../server/job-runs.ts');
  const saved = source.map(file => saveAskAttachment(scratch, { name: file.name, size: file.bytes.length, contentBase64: file.bytes.toString('base64') }));
  result.copies = saved.map((file, index) => ({ name: file.name, bytes: file.size, byteIdentical: digest(readFileSync(file.path)) === before[index] }));
  assert.ok(result.copies.every(file => file.byteIdentical));
  const paths = saved.map(file => `ask-uploads/${basename(file.path)}`);
  const recipe = {
    id: 'synthetic-selected-documents', title: 'Synthetic department handoff',
    description: `Read only these two selected copies in the current workroom: ${paths.join(' and ')}. They are synthetic Word and Excel documents. Compare the maintenance and accounts information and prepare an internal handoff.`,
    steps: ['Read the two named files using file tools. Report their exact shared reference, both contractor totals and their difference, plus the missing access information. Do not infer unreadable contents.', 'Include both source filenames. Do not contact anyone, use websites, run terminal commands, create or change files, or select a contractor.'],
    capabilities: ['read-files', 'analyse', 'draft'], allowedOrigins: [],
    limits: { maxRuntimeMinutes: 2, maxTurns: 6 }, evidence: 'The output cites the two selected files and the exact shared reference read from them.',
    schedule: null, status: 'shadow',
  };
  const store = new JobRunStore({ file: join(scratch, 'runs.json') });
  const turn = await executeRecipeJob(recipe, { mode: 'prepare', trigger: 'manual', idempotencyKey: 'selected-documents' }, { store });
  result.run = turn.run;
  const output = turn.run.evidence.filter(item => item.kind === 'output').map(item => item.note).join('\n');
  assert.ok(['completed', 'awaiting-approval'].includes(turn.run.status), `worker result: ${turn.run.status}`);
  assert.ok(output.includes(expected.reference), 'the unpredictable reference must be read from the documents');
  assert.match(output, /1,?375/); assert.match(output, /1,?485/); assert.match(output, /\b110\b/);
  assert.match(output, /access/i);
  result.ok = true;
  console.log('PASS actual Hermes read selected DOCX and XLSX, recovered the hidden reference, compared totals and prepared an internal handoff.');
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  console.error(result.error);
} finally {
  result.originalsUnchanged = names.every((name, index) => digest(readFileSync(join(fixtures, name))) === before[index]);
  result.finishedAt = new Date().toISOString();
  writeFileSync(report, JSON.stringify(result, null, 2), { mode: 0o600 });
  rmSync(scratch, { recursive: true, force: true });
}
