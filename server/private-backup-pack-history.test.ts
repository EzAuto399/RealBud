import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { austinCustomerPack } from './customer-pack-definition.ts';
import { validateCustomerPack } from './customer-packs.ts';
import { validatePrivateBusinessFile } from './private-workspace-backup.ts';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fixture() {
  const prior = validateCustomerPack(austinCustomerPack()), pack = structuredClone(prior);
  pack.revision++;
  const entry = { version: 1, phase: 'installed', pack, digest: digest(pack), installedAt: '2026-09-22T00:00:00.000Z',
    receipt: { addedRecipes: [], installedSkills: [], preservedRecipes: [] }, generation: 2,
    history: [{ pack: prior, digest: digest(prior), generation: 1, savedAt: '2026-09-21T00:00:00.000Z', recipes: prior.recipes, retiredRecipeIds: [] }],
    retiredRecipeIds: [] };
  return { value: { version: 1, installs: { [pack.id]: entry } }, entry };
}
// This is the shared admission boundary invoked by both legacy snapshots and v2 catalogs.
const validate = (value: unknown) => validatePrivateBusinessFile('customer-packs.json', value);
describe('portable pack configuration history', () => {
  it('accepts completed history without dropping prior configuration, and keeps old journals compatible', () => {
    const { value, entry } = fixture(), saved = structuredClone(value);
    expect(() => validate(value)).not.toThrow(); expect(value).toEqual(saved);
    const { generation: _generation, history: _history, retiredRecipeIds: _retired, ...legacy } = entry;
    expect(() => validate({ version: 1, installs: { [entry.pack.id]: legacy } })).not.toThrow();
  });
  it.each(['digest', 'generation', 'recipe', 'retired-path'] as const)('refuses corrupt %s in prior configuration', kind => {
    const { value, entry } = fixture(), history = entry.history[0]!;
    if (kind === 'digest') history.digest = '0'.repeat(64);
    if (kind === 'generation') history.generation = entry.generation;
    if (kind === 'recipe') history.recipes[0]!.id = 'unowned-recipe';
    if (kind === 'retired-path') (history.retiredRecipeIds as string[]).push('../outside');
    expect(() => validate(value)).toThrow(/history needs recovery/);
  });
  it('refuses an unfinished transition before either backup format can move it to another installation', () => {
    const { value, entry } = fixture(); Object.assign(entry, { transition: {} });
    expect(() => validate(value)).toThrow(/Finish or recover/);
  });
});
