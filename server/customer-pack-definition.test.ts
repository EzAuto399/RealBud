import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { austinCustomerPack } from './customer-pack-definition.ts';
import { officeCoreCustomerPack } from './office-core-pack.ts';
import { validateCustomerPack } from './customer-packs.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const support = join(root, 'pack', 'workflows', 'austin-accounts', 'support', 'rei-cloud-navigation');

describe('Austin office pack definition', () => {
  it('matches the published JSON byte for byte (regenerate with scripts/export-austin-office-pack.ts)', () => {
    const published = readFileSync(join(root, 'pack', 'workflows', 'austin-office', 'realbud-austin-office-v1.json'), 'utf8');
    expect(published).toBe(`${JSON.stringify(validateCustomerPack(austinCustomerPack()), null, 2)}\n`);
  });

  it('carries REI Cloud navigation in the Austin add-on pack only, never in office core', () => {
    const austin = validateCustomerPack(austinCustomerPack()), core = validateCustomerPack(officeCoreCustomerPack());
    expect(austin.revision).toBe(2);
    expect(austin.skills.map(skill => skill.id)).toEqual(['email-inbox-triage', 'rei-cloud-navigation']);
    expect(`realbud-${austin.id}-rei-cloud-navigation`.length).toBeLessThanOrEqual(64);
    expect(core.skills.map(skill => skill.id)).not.toContain('rei-cloud-navigation');
    expect(JSON.stringify(core)).not.toMatch(/rei-cloud-navigation|reimasterapps|reicid/i);
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
    expect(provenance).toMatchObject({ name: 'rei-cloud-navigation', pack: 'austin-office', packRevision: 2, firstParty: true, sha256: digest('SKILL.md'), siteMapSha256: digest('site-map.json') });
    const map = JSON.parse(readFileSync(join(support, 'site-map.json'), 'utf8'));
    expect(map).toMatchObject({ portal: 'rei-cloud', pack: 'austin-office', skill: 'rei-cloud-navigation' });
    expect(JSON.stringify(map)).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|reicid=(?!\{reicid\})/);
    // Source references beside the skill: every file is hashed, none is published, and they hold placeholders only.
    const references = readdirSync(join(support, 'references')).map(file => `references/${file}`).sort();
    expect(Object.keys(provenance.referencesSha256).sort()).toEqual(references);
    for (const file of references) {
      expect(provenance.referencesSha256[file]).toBe(digest(file));
      const text = readFileSync(join(support, file), 'utf8');
      expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|reicid=(?!\{reicid\})|\/Users\/|\b\d{5,}\b/);
    }
    expect(JSON.stringify(austinCustomerPack())).not.toContain('task-recipes');
  });
});
