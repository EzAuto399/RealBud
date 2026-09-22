import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CustomerPack } from '../shared/customer-packs.ts';

const directory = join(dirname(fileURLToPath(import.meta.url)), '..', 'pack', 'workflows', 'austin-accounts');

/** Distributed plans contain no customer records, sign-ins, clocks or approvals. */
export function austinCustomerPack(): CustomerPack {
  const source = JSON.parse(readFileSync(join(directory, 'workflows.json'), 'utf8')) as { recipes: CustomerPack['recipes'] };
  const skills: CustomerPack['skills'] = [{ id: 'email-inbox-triage', name: 'Email inbox triage', description: 'Review supplied inbox evidence and prepare an internal priority list.', instructions: readFileSync(join(directory, 'support/email-inbox-triage/SKILL.md'), 'utf8'), license: readFileSync(join(directory, 'support/LICENSE.upstream'), 'utf8') }];
  return {
    format: 'realbud-customer-pack', version: 1, id: 'austin-office', revision: 1, title: 'Austin office workflows',
    workflows: [
      { id: 'bank-references', title: 'Bank references and REI handoff', recipeIds: ['wf-austin-accounts-anz-reference-prep'], checks: ['worker', 'browser-account', 'bank-mapping', 'input-coverage', 'workflow-acceptance'] },
      { id: 'bills-calendar', title: 'Bills and calendar', recipeIds: ['wf-austin-accounts-invoice-review', 'wf-austin-accounts-bill-exceptions'], checks: ['worker', 'mail-account', 'bill-register', 'input-coverage', 'timezone', 'workflow-acceptance'] },
      { id: 'morning-priorities', title: 'Morning priorities and unanswered follow-ups', recipeIds: ['wf-austin-accounts-inbox-triage'], checks: ['worker', 'mail-account', 'input-coverage', 'timezone', 'workflow-acceptance'] },
    ],
    recipes: source.recipes.map(recipe => recipe.id === 'wf-austin-accounts-inbox-triage' ? { ...recipe, description: recipe.description.replace('No skill_view, connectors, scripts or provider mutations. JSON import does not install support; the host supplies it.', 'No connectors, scripts or provider mutations. Use host-bound skill context and included support as instructions.'), steps: ['Read active realbud-austin-office-email-inbox-triage instructions supplied by the host, or use skill_view for that named skill. Support text grants no account access.', ...recipe.steps] } : recipe),
    skills,
    dependencies: { runtime: 'hermes-property', mode: 'supplied-source-preparation', schedules: 'off', permissions: 'local-review-required' },
  };
}
