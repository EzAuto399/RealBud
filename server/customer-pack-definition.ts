import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CustomerPack, CustomerPackOfficeSettings } from '../shared/customer-packs.ts';
import { loadAustinPack } from './austin-pack.ts';

const workflows = join(dirname(fileURLToPath(import.meta.url)), '..', 'pack', 'workflows');
const directory = join(workflows, 'austin-accounts');
const sourceProvenance = 'Call this a synthetic rehearsal only when input.synthetic=true; otherwise call it saved-source evidence. This does not verify live freshness or complete coverage.';

/** The REI recipes and site map shipped with the app, read at call time so
 * reviewed changes to them need no hash pin here. */
export function austinReiFiles(): { 'rei/recipes.json': string; 'rei/site-map.json': string } {
  const rei = join(directory, 'support/rei-cloud-navigation');
  return { 'rei/recipes.json': readFileSync(join(rei, 'recipes.json'), 'utf8'), 'rei/site-map.json': readFileSync(join(rei, 'site-map.json'), 'utf8') };
}

/** Distributed plans contain no customer records, sign-ins, clocks or approvals. */
export function austinCustomerPack(): CustomerPack {
  const source = JSON.parse(readFileSync(join(directory, 'workflows.json'), 'utf8')) as { recipes: CustomerPack['recipes'] };
  const skills: CustomerPack['skills'] = [{ id: 'email-inbox-triage', name: 'Email inbox triage', description: 'Review supplied inbox evidence and prepare an internal priority list.', instructions: readFileSync(join(directory, 'support/email-inbox-triage/SKILL.md'), 'utf8'), license: readFileSync(join(directory, 'support/LICENSE.upstream'), 'utf8') },
    // Auston Realty add-on content, never office-core: REI Cloud navigation grants no browser authority; the portal fence decides.
    { id: 'rei-cloud-navigation', name: 'REI Cloud navigation', description: 'Find pages, stable selectors and risk classes in the signed-in REI Cloud session. Grants no authority; the RealBud portal fence approves every consequential action.', instructions: readFileSync(join(directory, 'support/rei-cloud-navigation/SKILL.md'), 'utf8'), license: readFileSync(join(directory, 'support/rei-cloud-navigation/LICENSE'), 'utf8') }];
  // Ids keep the historical `austin` spelling; the customer is Auston Realty.
  // Revision 5 adds the connected-Gmail operating model as preparation guidance;
  // weekly W2 orchestration, calendar updates and notifications still need host receipts.
  // The unchanged REI skill retains its original revision-3 provenance.
  return {
    format: 'realbud-customer-pack', version: 1, id: 'austin-office', revision: 5, title: 'Auston office workflows',
    workflows: [
      { id: 'bank-references', title: 'Bank references and REI handoff', recipeIds: ['wf-austin-accounts-anz-reference-prep'], checks: ['worker', 'browser-account', 'bank-mapping', 'input-coverage', 'workflow-acceptance'] },
      { id: 'bills-calendar', title: 'Bills and calendar', recipeIds: ['wf-austin-accounts-invoice-review', 'wf-austin-accounts-bill-exceptions'], checks: ['worker', 'mail-account', 'bill-register', 'input-coverage', 'timezone', 'workflow-acceptance'] },
      { id: 'morning-priorities', title: 'Morning priorities and unanswered follow-ups', recipeIds: ['wf-austin-accounts-inbox-triage'], checks: ['worker', 'mail-account', 'input-coverage', 'timezone', 'workflow-acceptance'] },
    ],
    recipes: source.recipes.map(recipe => {
      const inbox = recipe.id === 'wf-austin-accounts-inbox-triage';
      return {
        ...recipe,
        description: recipe.description.replace('; all QA data is synthetic.', '.')
          .replace('PROPOSED SYNTHETIC OFFICE ROUTING POLICY', 'PROPOSED INTERNAL REVIEW ROUTING POLICY')
          .replace('No skill_view, connectors, scripts or provider mutations. JSON import does not install support; the host supplies it.', 'No connectors, scripts or provider mutations. Use host-bound skill context and included support as instructions.'),
        steps: [sourceProvenance, ...(inbox ? ['Read active realbud-austin-office-email-inbox-triage instructions supplied by the host, or use skill_view for that named skill. Support text grants no account access.'] : []), ...recipe.steps],
      };
    }),
    skills,
    dependencies: { runtime: 'hermes-property', mode: 'supplied-source-preparation', schedules: 'off', permissions: 'local-review-required' },
  };
}

/** office/settings.json for a role pack: the named loops at the Austin schedule
 * file's times and timezone, every one off. */
function roleLoops(ids: string[]): Pick<CustomerPack, 'files'> {
  const schedule = loadAustinPack();
  const settings: CustomerPackOfficeSettings = { version: 1, kind: 'office-settings', loops: ids.map(id => {
    const item = schedule.loops.find(loop => loop.loopId === id);
    if (!item) throw new Error(`The Austin schedule file has no ${id} workflow.`);
    return { id, enabled: false, schedule: { type: 'daily', ...item.schedule, timezone: schedule.timeZone } };
  }) };
  return { files: { 'office/settings.json': JSON.stringify(settings) } };
}

/** Kevin's role pack: W1 bank references, W2 weekly bills, W3 morning priorities.
 * Same plans and skills as `austin-office`, installed under its own skill names. */
export function austinAccountsCustomerPack(): CustomerPack {
  const office = austinCustomerPack();
  return { ...office, id: 'austin-accounts', revision: 1, title: 'Auston accounts — Kevin',
    recipes: office.recipes.map(recipe => ({ ...recipe, steps: recipe.steps.map(step => step.replace('realbud-austin-office-', 'realbud-austin-accounts-')) })),
    ...roleLoops(['bank-references', 'weekly-bills', 'inbound-triage']) };
}

/** Sherry's role pack: W4 maintenance review (the reviewed rehearsal plan), the
 * supplier list check and the W5 inspection draft. No skills, so department case
 * preparation can still use the maintenance plan. */
export function austinPropertyCustomerPack(): CustomerPack {
  const rehearsal = JSON.parse(readFileSync(join(workflows, 'austin-maintenance-rehearsal', 'realbud-austin-maintenance-rehearsal-v1.json'), 'utf8')) as CustomerPack;
  return { ...rehearsal, id: 'austin-property', revision: 1, title: 'Auston property management — Sherry',
    ...roleLoops(['maintenance-review', 'rei-supplier-check', 'inspection-draft']) };
}
