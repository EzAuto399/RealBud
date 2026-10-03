import { describe, expect, it } from 'vitest';
import type { Recipe } from '../shared/contracts.ts';
import { austinCustomerPack } from './customer-pack-definition.ts';
import { validateCustomerPack } from './customer-packs.ts';
import { prepareJobPrompt } from './job-executor.ts';

function preparation() {
  const pack = validateCustomerPack(austinCustomerPack());
  const definition = pack.recipes.find(recipe => recipe.id === 'wf-austin-accounts-anz-reference-prep')!;
  const recipe = { ...definition, revision: 1, status: 'active', planApprovedAt: 1, approvedRevision: 1 } as Recipe;
  return { recipe, prompt: prepareJobPrompt(recipe) };
}

describe('W1 bank export and REI handoff roadmap', () => {
  it('carries the full intended host flow into the published preparation prompt without granting browser or import authority', () => {
    const { recipe, prompt } = preparation();
    expect(prompt).toContain('future host roadmap, not implemented orchestration or authority for this recipe');
    expect(prompt).toContain('user authenticates bank/REI and confirms accounts in browser-managed sessions');
    expect(prompt).toContain('Expiry requires human reauthentication');
    expect(prompt).toContain('no raw cookie copying or CLI cookie injection');
    expect(prompt).toContain('export bank CSV every two days for the reviewed range');
    expect(prompt).toContain('durable coverage checkpoints, detect gaps/overlaps');
    expect(prompt).toContain('never advance a checkpoint across an unread interval');
    expect(prompt).toContain('retain immutable raw CSV with source/account/range identity and digest');
    expect(prompt).toContain('Review local reference candidates; only the checked host exporter produces a proposed corrected CSV');
    expect(prompt).toContain('Future REI: bind reviewed CSV/account and verified import format');
    expect(prompt).toContain('Bud prepares a verified preview, user performs final financial posting, then Bud reads back receipts');
    expect(prompt).toContain('Unresolved gaps stay held');
    expect(prompt).toContain('No concrete live file/account or clock is bound here');
    expect(prompt).toContain('It cannot run the roadmap, use browser/session/token tools, export CSV, import to REI or claim those steps completed');
    expect(recipe.capabilities).toEqual(['read-files', 'analyse', 'draft']);
    expect(recipe.allowedOrigins).toEqual([]);
    expect(recipe.siteNotes).toBeNull();
    expect(recipe.schedule).toBeNull();
  });

  it('preserves the saved-source, mapping, coverage and reference-only result contract for the current recipe', () => {
    const { prompt } = preparation();
    expect(prompt).toContain('Read only workflow-inputs/accounts-bank-reference.json');
    expect(prompt).toContain('exact banking service, login/export route and customer CSV layout remain unverified until office fit check');
    expect(prompt).toContain('Require bankBrand=ANZ, formatConfirmed=true, mappingApproved=true, complete coverage and valid batch identity/revision');
    expect(prompt).toContain('otherwise block with coverageComplete=false, rows=[] and named holds');
    expect(prompt).toContain('hold ambiguous, unmatched, possible duplicate or short-stay batch rows');
    expect(prompt).toContain('keep duplicates as distinct rows, do not allocate a combined Airbnb payout');
    expect(prompt).toContain('hostValidation:{required:true,batchId,batchRevision,originalDigest,applied:false}');
    expect(prompt).toContain('The model creates NO CSV');
    expect(prompt).toContain('actionsPerformed must be []');
    expect(prompt).toContain('No bank/PMS posting/import/payment or Hermes cron');
    expect(prompt).toContain('Those prohibitions cannot be overridden by approval in this job');
  });
});
