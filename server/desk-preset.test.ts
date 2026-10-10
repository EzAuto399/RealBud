import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Recipe } from '../shared/contracts.ts';
import type { CustomerPack } from '../shared/customer-packs.ts';
import { coreOfficeDesk } from '../shared/desk-areas.ts';
import { austinAccountsCustomerPack, latestAustinAccountsCustomerPack } from './customer-pack-definition.ts';
import { deskChanges, previewPackChange, type PackSnapshot } from './customer-pack-upgrades.ts';
import { admitPack, createCustomerPackService, validateCustomerPack } from './customer-packs.ts';
import { officeDesk } from './desk-preset.ts';
import { CHANGED_PACK_MESSAGE, packSigningBytes } from './pack-signing.ts';
import { readPrivateJson, writePrivateJson } from './private-json.ts';
import { FICTIONAL_PACK_KEYS, signFictionalPack, withFictionalPublisher } from './testing/pack-publisher.ts';
import { privateTempRoot, removeFixture } from './testing/private-fixture.ts';

/** Two fictional offices on the same core: an accounts desk and a mail desk. */
function fictionalPack(id: string, title: string, workflows: [string, string][], desk?: CustomerPack['desk']): CustomerPack {
  return { format: 'realbud-customer-pack', version: 1, id, revision: 1, title,
    recipes: workflows.map(([workflow, name]) => ({ id: `wf-${id}-${workflow}`, title: name, description: 'Prepare fictional supplied sources for review.', steps: ['Read the supplied fictional sources.'], evidence: 'Source references.', capabilities: ['read-files', 'analyse', 'draft'], limits: { maxRuntimeMinutes: 2, maxTurns: 6 }, siteNotes: null, schedule: null, allowedOrigins: [] })),
    workflows: workflows.map(([workflow, name]) => ({ id: workflow, title: name, recipeIds: [`wf-${id}-${workflow}`], checks: ['input-coverage'] })),
    skills: [], dependencies: { runtime: 'hermes-property', mode: 'supplied-source-preparation', schedules: 'off', permissions: 'local-review-required' },
    ...(desk ? { desk } : {}) };
}
const accountsDesk = () => fictionalPack('fictional-accounts', 'Fictional Accounts Desk', [['bank-references', 'Bank references'], ['bills-calendar', 'Bills and calendar']], { areas: [
  { workflow: 'bank-references', title: 'Bank references', layout: 'review-list', notify: 'each' },
  { workflow: 'bills-calendar', title: 'Bills & calendar', layout: 'calendar', notify: 'summary' },
] });
const mailDesk = () => fictionalPack('fictional-mail', 'Fictional Mail Desk', [['morning-priorities', 'Morning priorities']], { areas: [
  { workflow: 'morning-priorities', title: 'Morning priorities', layout: 'priority-list', notify: 'off' },
] });
const withoutDesk = (pack: CustomerPack): CustomerPack => { const { desk: _desk, ...rest } = pack; return rest; };
const digest = (pack: CustomerPack) => createHash('sha256').update(JSON.stringify(pack)).digest('hex');

describe('a workflow pack presets its Desk work areas', () => {
  it('accepts both fictional packs and appends desk after the existing keys', () => {
    for (const pack of [accountsDesk(), mailDesk()]) {
      const valid = validateCustomerPack(pack);
      expect(valid.desk).toEqual(pack.desk);
      expect(Object.keys(valid).at(-1)).toBe('desk');
    }
    expect(Object.hasOwn(validateCustomerPack(withoutDesk(accountsDesk())), 'desk')).toBe(false);
  });

  type Draft = { workflows: { id: string }[]; desk: { areas: Record<string, unknown>[] } };
  it.each<[string, (pack: Draft) => void, RegExp]>([
    ['an unknown layout', pack => { pack.desk.areas[0].layout = 'kanban'; }, /^Unknown Desk layout kanban\.$/],
    ['a workflow outside this pack', pack => { pack.desk.areas[0].workflow = 'morning-priorities'; }, /different workflow in this pack/],
    ['a duplicate workflow', pack => { pack.desk.areas[1].workflow = 'bank-references'; }, /different workflow in this pack/],
    ['an extra area key', pack => { pack.desk.areas[0].icon = 'bank'; }, /Unsupported pack fields/],
    ['an extra desk key', pack => { Object.assign(pack.desk, { order: [] }); }, /Unsupported pack fields/],
    ['no areas', pack => { pack.desk.areas = []; }, /one to eight work areas/],
    ['more than eight areas', pack => { pack.desk.areas = Array(9).fill(pack.desk.areas[0]); }, /one to eight work areas/],
    ['an unknown notice level', pack => { pack.desk.areas[0].notify = 'email'; }, /notice level/],
    ['a missing title', pack => { delete pack.desk.areas[0].title; }, /plain title/],
    ['an untrimmed title', pack => { pack.desk.areas[0].title = ' Bank references'; }, /plain title/],
    ['a title over 40 characters', pack => { pack.desk.areas[0].title = 'B'.repeat(41); }, /plain title/],
    ['a bidi control in the title', pack => { pack.desk.areas[0].title = 'Bank ‮references'; }, /plain title/],
  ])('refuses %s', (_name, change, message) => {
    const pack = structuredClone(accountsDesk()) as unknown as Draft;
    change(pack);
    expect(() => validateCustomerPack(pack)).toThrow(message);
  });

  // What this core can show is checked on import only: a saved install is read by shape.
  it.each<[string, (pack: Draft) => void, RegExp]>([
    ['a layout its area cannot render', pack => { pack.desk.areas[1].layout = 'priority-list'; }, /can't show the Bills and calendar workflow as a Priority list on Desk/],
    ['a workflow this core cannot show', pack => { pack.workflows[0].id = 'fictional-inspections'; pack.desk.areas[0].workflow = 'fictional-inspections'; }, /^This RealBud can't show the Bank references workflow on Desk yet\.$/],
  ])('refuses to import %s, which a saved install may still hold', (_name, change, message) => {
    const pack = structuredClone(accountsDesk()) as unknown as Draft;
    change(pack);
    expect(validateCustomerPack(pack).desk).toEqual(pack.desk);
    expect(() => admitPack(signFictionalPack(pack), FICTIONAL_PACK_KEYS, true)).toThrow(message);
  });

  it('signs the desk preset with the canonical manifest', () => {
    const signed = signFictionalPack(accountsDesk());
    expect(packSigningBytes(signed).toString()).toContain('"desk":{"areas":[{"layout":"review-list","notify":"each","title":"Bank references","workflow":"bank-references"}');
    expect(admitPack(signed, FICTIONAL_PACK_KEYS, true).desk).toEqual(accountsDesk().desk);
    const quieter = structuredClone(signed); quieter.desk!.areas[0].notify = 'off';
    expect(() => admitPack(quieter, FICTIONAL_PACK_KEYS, true)).toThrow(CHANGED_PACK_MESSAGE);
  });
});

describe('the pack change review lists Desk changes', () => {
  const recipes = (pack: CustomerPack) => pack.recipes.map(recipe => ({ ...recipe, revision: 1, status: 'shadow', createdAt: 1, updatedAt: 1, planApprovedAt: null, approvedRevision: null, attachment: null, submitAcknowledgedAt: null }) as Recipe);
  const deps = (pack: CustomerPack) => ({ listRecipes: () => recipes(pack), artifacts: () => [], artifactState: async () => 'missing' as const, scope: () => 'a'.repeat(64) });
  const before = withoutDesk(accountsDesk()), after = { ...accountsDesk(), revision: 2 };
  const toPreset = ['Bank references notices: Problems only → Each new item', 'Renames the Bills and calendar tab to Bills & calendar', 'Removes the Mail priorities tab', 'Changes the order of the Desk tabs'];

  it('compares the installed preset, or the core Desk, with the target on upgrade and rollback', async () => {
    const upgrade = await previewPackChange({ pack: before, digest: digest(before) }, after, [], deps(before));
    expect(upgrade.preview).toMatchObject({ action: 'upgrade', desk: toPreset, canApply: true });
    const prior: PackSnapshot = { pack: before, digest: digest(before), generation: 1, savedAt: '2026-10-10T00:00:00.000Z', recipes: before.recipes, retiredRecipeIds: [] };
    const rollback = await previewPackChange({ pack: after, digest: digest(after), generation: 2, history: [prior] }, before, [], deps(after), prior);
    expect(rollback.preview).toMatchObject({ action: 'rollback', desk: ['Adds the Mail priorities tab (Priority list)', 'Renames the Bills & calendar tab to Bills and calendar', 'Bank references notices: Each new item → Problems only', 'Changes the order of the Desk tabs'] });
  });

  it('names layout changes, and lists nothing when neither version presets Desk', () => {
    const calendarAsList = structuredClone(after); calendarAsList.desk!.areas[1].layout = 'review-list';
    expect(deskChanges(after, calendarAsList)).toEqual(['Bills & calendar layout: Calendar → List']);
    expect(deskChanges(austinAccountsCustomerPack(), latestAustinAccountsCustomerPack())).toEqual([]);
  });
});

describe('the office Desk preset', () => {
  const desk = (pack: CustomerPack | null, workflowPackId: string | null, selectedWorkflows: string[]) => officeDesk({
    agency: async () => ({ workflowPackId, selectedWorkflows }),
    installedPack: async id => { expect(id).toBe(workflowPackId); return pack; },
  });
  const unlisted = { mail: { id: 'mail', title: 'Mail priorities', layout: 'priority-list', notify: 'summary', available: false },
    bills: { id: 'bills', title: 'Bills and calendar', layout: 'calendar', notify: 'summary', available: false },
    bank: { id: 'bank', title: 'Bank references', layout: 'review-list', notify: 'off', available: false },
    shared: { id: 'shared-work', title: 'Shared work', layout: 'review-list', notify: null, available: true } };

  it('keeps the core Desk without a chosen pack, an installed pack or a pack preset', async () => {
    expect(await desk(accountsDesk(), null, ['bank-references'])).toEqual(coreOfficeDesk(['bank-references']));
    expect(await desk(null, 'fictional-accounts', ['bank-references'])).toEqual(coreOfficeDesk(['bank-references']));
    expect(await desk(latestAustinAccountsCustomerPack(), 'austin-accounts', ['bank-references'])).toEqual(coreOfficeDesk(['bank-references']));
  });

  it('shows the accounts pack areas first, available only for the workflows the office runs', async () => {
    expect(await desk(accountsDesk(), 'fictional-accounts', ['bank-references'])).toEqual({ source: { kind: 'pack', packId: 'fictional-accounts', revision: 1 }, areas: [
      { id: 'bank', title: 'Bank references', layout: 'review-list', notify: 'each', available: true },
      { id: 'bills', title: 'Bills & calendar', layout: 'calendar', notify: 'summary', available: false },
      unlisted.mail, unlisted.shared,
    ] });
    const all = await desk(accountsDesk(), 'fictional-accounts', ['bank-references', 'bills-calendar', 'morning-priorities']);
    expect(all.areas.map(area => [area.id, area.available])).toEqual([['bank', true], ['bills', true], ['mail', false], ['shared-work', true]]);
  });

  it('shows the mail pack with mail only, off unless the office runs morning priorities', async () => {
    const area = { id: 'mail', title: 'Morning priorities', layout: 'priority-list', notify: 'off' };
    expect(await desk(mailDesk(), 'fictional-mail', [])).toEqual({ source: { kind: 'pack', packId: 'fictional-mail', revision: 1 }, areas: [{ ...area, available: false }, unlisted.bills, unlisted.bank, unlisted.shared] });
    expect((await desk(mailDesk(), 'fictional-mail', ['morning-priorities'])).areas[0]).toEqual({ ...area, available: true });
  });
});

describe('the installed pack reader', () => {
  const roots: string[] = [];
  afterEach(async () => { for (const root of roots.splice(0)) await removeFixture(root); });
  it('reads the installed preset for the office Desk', async () => {
    const root = privateTempRoot(join(realpathSync(tmpdir()), 'rb-desk-preset-')); roots.push(root);
    let saved: Recipe[] = [];
    const service = withFictionalPublisher(createCustomerPackService)({ directory: root, profileDirectory: () => join(root, 'profile'), workroomDirectory: () => join(root, 'vault'),
      listRecipes: () => saved, saveRecipes: (inputs: unknown[]) => (saved = [...saved, ...inputs.map(raw => ({ ...(raw as object), revision: 1, createdAt: 1, updatedAt: 1, planApprovedAt: null, approvedRevision: null, attachment: null, submitAcknowledgedAt: null }) as Recipe)]) });
    const pack = accountsDesk(), preview = await service.preview(pack);
    await service.install(pack, preview.digest);
    expect(await service.installedPack('fictional-mail')).toBeNull();
    const office = await officeDesk({ agency: () => ({ workflowPackId: pack.id, selectedWorkflows: ['bills-calendar'] }), installedPack: id => service.installedPack(id) });
    expect(office.source).toEqual({ kind: 'pack', packId: 'fictional-accounts', revision: 1 });
    expect(office.areas.map(area => [area.id, area.notify, area.available])).toEqual([['bank', 'each', false], ['bills', 'summary', true], ['mail', 'summary', false], ['shared-work', null, true]]);
    // A core that can no longer render the saved layout (a later release, or a downgrade): the install stays readable and the area shows its default.
    const file = join(root, 'customer-packs.json'), journal = await readPrivateJson(file, 2_000_000) as { installs: Record<string, { pack: CustomerPack; digest: string }> };
    const entry = journal.installs[pack.id]!;
    entry.pack.desk!.areas[1].layout = 'priority-list';
    entry.digest = digest(validateCustomerPack(entry.pack));
    await writePrivateJson(file, journal);
    expect((await service.installedPack(pack.id))?.desk?.areas[1]).toMatchObject({ workflow: 'bills-calendar', layout: 'priority-list' });
    const fallback = await officeDesk({ agency: () => ({ workflowPackId: pack.id, selectedWorkflows: ['bills-calendar'] }), installedPack: id => service.installedPack(id) });
    expect(fallback.areas[1]).toEqual({ id: 'bills', title: 'Bills & calendar', layout: 'calendar', notify: 'summary', available: true });
  });
});
