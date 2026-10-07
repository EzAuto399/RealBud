import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { CustomerPack } from '../shared/customer-packs.ts';
import { austinAccountsCustomerPack, austinCustomerPack, austinPropertyCustomerPack, austinReiFiles } from './customer-pack-definition.ts';
import { officeCoreCustomerPack } from './office-core-pack.ts';
import { validateCustomerPack } from './customer-packs.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const support = join(root, 'pack', 'workflows', 'austin-accounts', 'support', 'rei-cloud-navigation');

describe('Austin office pack definition', () => {
  it('loads the published JSON, already validated and canonical, at its pinned digest', () => {
    const published = readFileSync(join(root, 'pack', 'workflows', 'austin-office', 'realbud-austin-office-v1.json'), 'utf8');
    expect(published).toBe(`${JSON.stringify(validateCustomerPack(austinCustomerPack()), null, 2)}\n`);
    // Reviewed published digests (austin-office rev 6, austin-accounts rev 2, austin-property rev 1); a change needs a new reviewed revision.
    const digest = (pack: unknown) => createHash('sha256').update(JSON.stringify(validateCustomerPack(pack))).digest('hex');
    expect(digest(austinCustomerPack())).toBe('30a01d5df074494150963ac910873c4c482d12d1e1d19e7b8b7268d33549eceb');
    expect(digest(austinAccountsCustomerPack())).toBe('2ffa86f4d3325bfd5358d1c750e3af56ad0e665d282999ff9c2edc78c226599c');
    expect(digest(austinPropertyCustomerPack())).toBe('f41e00c5365e91f83fc4f836da3503f07ec8b1b5952c8b2f68b802464deaa001');
  });

  it('embeds the support SKILL and LICENSE files verbatim, and the role packs stay copies of their reviewed sources', () => {
    const file = (path: string) => readFileSync(join(root, 'pack/workflows/austin-accounts/support', path), 'utf8');
    const support = [{ instructions: file('email-inbox-triage/SKILL.md'), license: file('LICENSE.upstream') }, { instructions: file('rei-cloud-navigation/SKILL.md'), license: file('rei-cloud-navigation/LICENSE') }, { instructions: file('property-management/SKILL.md'), license: file('property-management/LICENSE') }];
    const office = austinCustomerPack(), accounts = austinAccountsCustomerPack(), property = austinPropertyCustomerPack();
    for (const pack of [office, accounts]) expect(pack.skills.map(({ instructions, license }) => ({ instructions, license }))).toEqual(support);
    const rename = (pack: CustomerPack) => ({ ...pack, recipes: pack.recipes.map(recipe => ({ ...recipe, steps: recipe.steps.map(step => step.replace('realbud-austin-office-', 'realbud-austin-accounts-')) })) });
    const body = ({ id: _id, revision: _revision, title: _title, files: _files, ...rest }: CustomerPack) => rest;
    expect(body(accounts)).toEqual(body(rename(office)));
    const rehearsal = JSON.parse(readFileSync(join(root, 'pack/workflows/austin-maintenance-rehearsal/realbud-austin-maintenance-rehearsal-v1.json'), 'utf8')) as CustomerPack;
    expect(body(property)).toEqual(body(rehearsal));
  });

  it('carries REI Cloud navigation in the Austin add-on pack only, never in office core', () => {
    const austin = validateCustomerPack(austinCustomerPack()), core = validateCustomerPack(officeCoreCustomerPack());
    expect(austin.revision).toBe(6);
    expect(austin.title).toBe('Auston office workflows');
    expect(austin.skills.map(skill => skill.id)).toEqual(['email-inbox-triage', 'rei-cloud-navigation', 'property-management']);
    expect(`realbud-${austin.id}-rei-cloud-navigation`.length).toBeLessThanOrEqual(64);
    expect(core.skills.map(skill => skill.id)).not.toContain('rei-cloud-navigation');
    expect(JSON.stringify(core)).not.toMatch(/rei-cloud-navigation|reimasterapps|reicid/i);
  });

  it('publishes source-neutral plans without widening capabilities or erasing routing review', () => {
    const pack = validateCustomerPack(austinCustomerPack());
    const source = JSON.parse(readFileSync(join(root, 'pack/workflows/austin-accounts/workflows.json'), 'utf8'));
    for (const recipe of pack.recipes) {
      const original = source.recipes.find((row: { id: string }) => row.id === recipe.id);
      expect(recipe.description).not.toMatch(/all QA data is synthetic|PROPOSED SYNTHETIC OFFICE ROUTING POLICY/);
      expect(recipe.steps[0]).toContain('only when input.synthetic=true');
      expect(recipe.steps[0]).toContain('otherwise call it saved-source evidence');
      expect(recipe.steps[0]).toContain('does not verify live freshness or complete coverage');
      for (const key of ['capabilities', 'limits', 'schedule', 'allowedOrigins', 'siteNotes'] as const) expect(recipe[key]).toEqual(original[key]);
    }
    expect(pack.recipes[0].description).toContain("PROPOSED INTERNAL REVIEW ROUTING POLICY, awaiting Kevin's validation");
  });

  it('keeps the skill instruction-only: fence is the authority and account values are placeholders', () => {
    const skill = austinCustomerPack().skills.find(item => item.id === 'rei-cloud-navigation')!;
    const text = skill.instructions;
    expect(text).toMatch(/This skill grants nothing/);
    for (const source of ['server/portal-fence.ts', 'server/browser-runtime.ts', 'docs/PORTAL-WORK.md', 'docs/decisions/2026-09-23-browser-task-authority.md']) expect(text).toContain(source);
    expect(text).toContain('Export Only'); expect(text).toMatch(/never choose "Dismiss All"/i);
    // No reicid value, email address, business code or long record number: only placeholders.
    expect([...text.matchAll(/reicid=([^\s`)]*)/g)].map(match => match[1])).toEqual(expect.arrayContaining(['{reicid}']));
    expect([...text.matchAll(/reicid=([^\s`)]*)/g)].every(match => match[1] === '{reicid}')).toBe(true);
    expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(text).not.toMatch(/\b\d{5,}\b/);
    expect(text).toContain('`{business}`');
    expect(text).not.toMatch(/business code[^.\n]*\b[A-Z]{2,}\d*\b/);
  });

  it('records first-party provenance whose digest matches the installed text', () => {
    const provenance = JSON.parse(readFileSync(join(support, 'provenance.json'), 'utf8'));
    const digest = (file: string) => createHash('sha256').update(readFileSync(join(support, file))).digest('hex');
    // This is the skill's original publication provenance, not the current pack version.
    expect(provenance).toMatchObject({ name: 'rei-cloud-navigation', pack: 'austin-office', packRevision: 3, firstParty: true, sha256: digest('SKILL.md'), siteMapSha256: digest('site-map.json'), recipesSha256: digest('recipes.json') });
    const map = JSON.parse(readFileSync(join(support, 'site-map.json'), 'utf8'));
    expect(map).toMatchObject({ portal: 'rei-cloud', pack: 'austin-office', skill: 'rei-cloud-navigation' });
    expect(JSON.stringify(map)).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|reicid=(?!\{reicid\})/);
    // Source references beside the skill: every file is hashed, none is published, and they hold placeholders only.
    const references = readdirSync(join(support, 'references')).map(file => `references/${file}`).sort();
    expect(references).toEqual(expect.arrayContaining(['references/task-recipes.md', 'references/website-map.md']));
    expect(Object.keys(provenance.referencesSha256).sort()).toEqual(references);
    for (const file of references) {
      expect(provenance.referencesSha256[file]).toBe(digest(file));
      const text = readFileSync(join(support, file), 'utf8');
      expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|reicid=(?!\{reicid\})|\/Users\/|\b\d{5,}\b/);
      expect(text).not.toMatch(/password\s*[:=]|C:\\/i);
      expect(text).toMatch(/Austin Realty add-on pack source reference, not RealBud core/);
    }
    const websiteMap = readFileSync(join(support, 'references', 'website-map.md'), 'utf8');
    expect(websiteMap).not.toMatch(/read_safe_labels: \[[^\]]*Preview/);
    expect(websiteMap).not.toMatch(/- click: Preview/);
    expect(websiteMap).toMatch(/recipe: receipt-register[\s\S]*?grant_needs: \[download\][\s\S]*?- select: \{field: Output, option: Export Only\}/);
    expect(websiteMap).toMatch(/recipe: open-session[\s\S]*?- check: account/);
    expect(JSON.stringify(austinCustomerPack())).not.toMatch(/task-recipes|website-map/);
  });

  it('carries the property-management wording moved out of core Bud, with provenance pinned to this revision', () => {
    const pm = join(root, 'pack', 'workflows', 'austin-accounts', 'support', 'property-management');
    const provenance = JSON.parse(readFileSync(join(pm, 'provenance.json'), 'utf8'));
    const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
    const pack = validateCustomerPack(austinCustomerPack()), skill = pack.skills.find(item => item.id === 'property-management')!;
    expect(provenance).toMatchObject({ name: 'property-management', pack: 'austin-office', packRevision: 6, firstParty: true,
      sha256: sha(readFileSync(join(pm, 'SKILL.md'))), licenseSha256: sha(readFileSync(join(pm, 'LICENSE'))) });
    // The published revision-6 pack; the next reviewed revision moves this pin.
    expect(sha(JSON.stringify(pack))).toBe(provenance.packSha256);
    expect(skill.instructions).toMatch(/Australian residential property-management desk assistant/);
    expect(skill.instructions).toMatch(/No notices\. No trust/);
    expect(skill.instructions).toMatch(/"weeklyRentCents"/);
    expect(skill.instructions).toMatch(/It is not RealBud core/);
    expect(`realbud-austin-accounts-${skill.id}`.length).toBeLessThanOrEqual(64);
    expect(JSON.stringify(validateCustomerPack(officeCoreCustomerPack()))).not.toMatch(/property-management desk|Form 11|weeklyRentCents/);
  });

  it('reads shipped text with LF endings, so a CRLF checkout keeps the built-in digest and REI files (Windows #20)', async () => {
    const digest = (pack: unknown) => createHash('sha256').update(JSON.stringify(validateCustomerPack(pack))).digest('hex');
    const expected = digest(austinCustomerPack()), rei = austinReiFiles();
    vi.resetModules();
    vi.doMock('node:fs', async original => {
      const fs = await original<typeof import('node:fs')>();
      const readFileSync = ((path: string, options?: unknown) => {
        const value = fs.readFileSync(path, options as BufferEncoding);
        return /\.json$|SKILL\.md$|LICENSE/.test(String(path)) && typeof value === 'string' ? value.replace(/\n/g, '\r\n') : value;
      }) as typeof fs.readFileSync;
      return { ...fs, readFileSync, default: { ...fs, readFileSync } };
    });
    try {
      const definition = await import('./customer-pack-definition.ts');
      const crlf = definition.austinCustomerPack();
      expect(crlf.skills.every(skill => skill.instructions.includes('\n') && !skill.instructions.includes('\r'))).toBe(true);
      expect(digest(crlf)).toBe(expected);
      expect(definition.austinReiFiles()).toEqual(rei);
    } finally { vi.doUnmock('node:fs'); vi.resetModules(); }
  });

  it('points the REI map simulation at the Austin reference, never at the core Hermes profile', () => {
    const sim = readFileSync(join(root, 'scripts', 'qa-rei-map-sim.mjs'), 'utf8');
    expect(sim).toContain('"pack/workflows/austin-accounts/support/rei-cloud-navigation/references/website-map.md"');
    expect(sim).not.toContain('pack/property');
    expect(sim).toContain('REI_MAP_OVERRIDE');
  });
});
