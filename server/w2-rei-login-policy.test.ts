import { describe, expect, it } from 'vitest';
import { austinCustomerPack } from './customer-pack-definition.ts';
import { prepareJobPrompt } from './job-executor.ts';
import { validateCustomerPack } from './customer-packs.ts';
import type { Recipe } from '../shared/contracts.ts';

describe('W2 client sign-in boundary in preparation instructions', () => {
  it.each(['wf-austin-accounts-invoice-review', 'wf-austin-accounts-bill-exceptions'])(
    'keeps %s local while requiring personal client sign-in and account confirmation before a later attended REI read', id => {
      const definition = austinCustomerPack().recipes.find(recipe => recipe.id === id)!;
      const recipe = { ...definition, revision: 1, status: 'active', planApprovedAt: 1, approvedRevision: 1 } as Recipe;
      const prompt = prepareJobPrompt(recipe);
      expect(definition.description.length).toBeLessThanOrEqual(4000);
      expect(prompt).toContain('Before any later attended REI read, each run waits for the user to sign in as the client and confirm agency/account');
      expect(prompt).toContain('CSV or an old session is no confirmation');
      expect(prompt).toContain('Bud never handles credentials or logs out');
      expect(prompt).toContain('never substitute demo-book data or search other folders, mailboxes or websites');
      expect(recipe.capabilities).toEqual(['read-files', 'analyse', 'draft']);
      expect(recipe.allowedOrigins).toEqual([]);
      expect(recipe.schedule).toBeNull();
    },
  );
});

describe('connected Gmail operating cadence and review destinations', () => {
  const published = () => validateCustomerPack(austinCustomerPack());
  const promptFor = (id: string) => {
    const definition = published().recipes.find(recipe => recipe.id === id)!;
    const recipe = { ...definition, revision: 1, status: 'active', planApprovedAt: 1, approvedRevision: 1 } as Recipe;
    return { recipe, prompt: prepareJobPrompt(recipe) };
  };

  it.each(['wf-austin-accounts-invoice-review', 'wf-austin-accounts-bill-exceptions'])(
    'keeps %s sourced weekly from connected Gmail, with a reference CSV and host-owned calendar/notification handoff', id => {
      const { recipe, prompt } = promptFor(id);
      expect(prompt).toContain('W2 target: weekly review of the connected Composio Gmail account');
      expect(prompt).toContain('Kevin, the sole W2 owner');
      expect(prompt).toContain('this preparation stage reads saved input, not the mailbox directly');
      expect(prompt).toContain('Property.csv as an example/reference for matching and timing');
      expect(prompt).toContain('Never require a fresh CSV, use its arrival as the trigger, or import it as ongoing bill truth');
      expect(prompt).toContain('new bills and justified missing-bill follow-ups for RealBud calendar/schedules');
      expect(prompt).toContain('source IDs to avoid duplicates');
      expect(prompt).toContain('in-app notification to Kevin explaining findings and gaps');
      expect(prompt).toContain('Weekly W2 orchestration is not implemented');
      expect(prompt).toContain('Return proposals; only host receipts prove calendar writes or in-app notification');
      expect(prompt).toContain('A generic recipe clock is no substitute');
      expect(prompt).toContain('REI effects stay simulated');
      expect(recipe.schedule).toBeNull();
      expect(recipe.capabilities).toEqual(['read-files', 'analyse', 'draft']);
      expect(recipe.allowedOrigins).toEqual([]);
    },
  );

  it('keeps W3 daily before work on the same connected Gmail scope without selecting a new account or enabling a clock', () => {
    const { recipe, prompt } = promptFor('wf-austin-accounts-inbox-triage');
    expect(prompt).toContain('W3 runs daily before work from the same connected Composio Gmail account as W2');
    expect(prompt).toContain('reviewed office time/timezone');
    expect(prompt).toContain('Host collection supplies scoped inbox and sent context');
    expect(prompt).toContain('urgent decisions, unanswered questions, waiting/follow-ups and FYIs');
    expect(prompt).toContain('Brief/notification proposals only; host receipts prove persistence or notification');
    expect(prompt).toContain('No sends or clock edits');
    expect(prompt).toContain('No Hermes cron');
    expect(recipe.schedule).toBeNull();
    expect(recipe.capabilities).toEqual(['read-files', 'analyse', 'draft']);
    expect(recipe.allowedOrigins).toEqual([]);
    expect(recipe.steps).toHaveLength(12);
  });
});
