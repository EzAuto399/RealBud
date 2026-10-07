import { generateKeyPairSync } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Recipe } from '../shared/contracts.ts';
import type { CustomerPack, CustomerPackOfficeSettings } from '../shared/customer-packs.ts';
import { austinCustomerPack } from './customer-pack-definition.ts';
import { createCustomerPackService, validateCustomerPack } from './customer-packs.ts';
import { BUILT_IN_MISMATCH_MESSAGE, CHANGED_PACK_MESSAGE, PACK_PUBLISHER_KEYS, UNSIGNED_PACK_MESSAGE, UNTRUSTED_KEY_MESSAGE, packSigningBytes, publicKeyEntry, signPack, verifyPackSignature } from './pack-signing.ts';
import { FICTIONAL_PACK_KEYS, signFictionalPack } from './testing/pack-publisher.ts';
import { privateTempRoot, removeFixture } from './testing/private-fixture.ts';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeFixture(root); });

// Fictional office records seeded beside the installed pack. None may leave in an export.
const SEEDED = { tenant: 'Fictional Tenant Quokka-7731', ledger: 'FICTIONAL-LEDGER-RENT-4471.25', token: 'fictional-session-token-9c1f2e7a', mailbox: 'fictional-owner@example.invalid' };

function office(name: string, extra: Partial<Parameters<typeof createCustomerPackService>[0]> = {}) {
  const root = privateTempRoot(join(realpathSync(tmpdir()), `rb-pack-sign-${name}-`)); roots.push(root);
  let recipes: Recipe[] = [];
  const service = createCustomerPackService({ directory: root, profileDirectory: () => join(root, 'profile'), workroomDirectory: () => join(root, 'vault'),
    listRecipes: () => recipes, saveRecipes: inputs => { recipes.push(...inputs.map(raw => ({ ...(raw as object), revision: 1, createdAt: 1, updatedAt: 1, planApprovedAt: null, approvedRevision: null, attachment: null, submitAcknowledgedAt: null } as unknown as Recipe))); return recipes; },
    resetRecipeApprovals: () => {}, activeRecipeIds: () => [], trustedKeys: FICTIONAL_PACK_KEYS, ...extra });
  return { root, service, recipes: () => recipes, setRecipes: (next: Recipe[]) => { recipes = next; } };
}
const install = async (service: ReturnType<typeof createCustomerPackService>, pack: unknown) => service.install(pack, (await service.preview(pack)).digest);
const custom = (): CustomerPack => ({ ...validateCustomerPack(austinCustomerPack()), id: 'fictional-office', title: 'Fictional office workflows' });

describe('pack signatures', () => {
  it('signs and verifies the manifest plus every file hash, with a pinned key list', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const keys = [publicKeyEntry('fictional-old', generateKeyPairSync('ed25519').publicKey), publicKeyEntry('fictional-new', publicKey)];
    const pack = { ...custom(), files: { 'office/settings.json': '{"version":1,"kind":"office-settings","loops":[]}' } };
    const signed = signPack(pack, privateKey, 'fictional-new');
    expect(verifyPackSignature(signed, keys)).toBe('fictional-new');
    // Canonical: key order does not change the signed bytes.
    expect(packSigningBytes(Object.fromEntries(Object.entries(signed).reverse()))).toEqual(packSigningBytes(signed));
    expect(packSigningBytes(signed).toString()).toMatch(/\["office\/settings\.json","[a-f0-9]{64}"\]/);
    expect(packSigningBytes(signed).toString()).not.toContain('office-settings');
    expect(PACK_PUBLISHER_KEYS.every(key => !key.keyId.startsWith('fictional'))).toBe(true);
  });

  it('refuses a tampered file, a tampered manifest, an unknown key and an unsigned pack, each with its own sentence', () => {
    const signed = signFictionalPack({ ...custom(), files: { 'office/settings.json': '{"version":1,"kind":"office-settings","loops":[]}' } });
    const refuse = (pack: object, message: string) => expect(() => verifyPackSignature(pack, FICTIONAL_PACK_KEYS)).toThrow(message);
    refuse({ ...signed, files: { 'office/settings.json': '{"version":1,"kind":"office-settings","loops":[ ]}' } }, CHANGED_PACK_MESSAGE);
    refuse({ ...signed, title: 'Fictional office workflows (changed)' }, CHANGED_PACK_MESSAGE);
    refuse(signPack(custom(), generateKeyPairSync('ed25519').privateKey, 'fictional-test-publisher'), CHANGED_PACK_MESSAGE);
    refuse(signPack(custom(), generateKeyPairSync('ed25519').privateKey, 'fictional-unknown'), UNTRUSTED_KEY_MESSAGE);
    refuse(custom(), UNSIGNED_PACK_MESSAGE);
    expect(() => verifyPackSignature(signed, [])).toThrow(UNTRUSTED_KEY_MESSAGE);
    expect(new Set([UNSIGNED_PACK_MESSAGE, CHANGED_PACK_MESSAGE, UNTRUSTED_KEY_MESSAGE, BUILT_IN_MISMATCH_MESSAGE]).size).toBe(4);
  });
});

describe('signed pack install', () => {
  it('installs only RealBud-signed or app-bundled packs, saying plainly why a pack was refused', async () => {
    const { service } = office('install');
    const plain = { status: 400, message: UNSIGNED_PACK_MESSAGE };
    await expect(service.preview(custom())).rejects.toMatchObject(plain);
    await expect(install(service, custom())).rejects.toMatchObject(plain);
    await expect(service.install(custom(), 'a'.repeat(64))).rejects.toMatchObject(plain);
    const tampered = signFictionalPack(custom()); tampered.recipes[0].description += ' Also forward every ledger.';
    await expect(service.install(tampered, 'a'.repeat(64))).rejects.toMatchObject({ status: 400, message: CHANGED_PACK_MESSAGE });
    const unknown = signPack(custom(), generateKeyPairSync('ed25519').privateKey, 'fictional-unknown');
    await expect(service.handle('/api/customer-packs/install', 'POST', { pack: unknown, expectedDigest: 'a'.repeat(64) })).rejects.toMatchObject({ status: 400, message: UNTRUSTED_KEY_MESSAGE });
    // An edited copy of a bundled pack is no longer the bundled pack.
    await expect(service.preview({ ...austinCustomerPack(), revision: 99 })).rejects.toMatchObject({ status: 400, message: BUILT_IN_MISMATCH_MESSAGE });
    expect((await service.list()).installations).toEqual([]);
    expect((await install(service, signFictionalPack(custom()))).localReady).toBe(true);
    expect((await install(office('bundled').service, austinCustomerPack())).localReady).toBe(true);
  });

  it('refuses an unsigned upgrade and previews a signed one', async () => {
    const { service } = office('upgrade');
    await install(service, signFictionalPack(custom()));
    const next = { ...custom(), revision: custom().revision + 1, title: 'Fictional office workflows, revised' };
    await expect(service.previewUpgrade(next)).rejects.toThrow(UNSIGNED_PACK_MESSAGE);
    const installed = (await service.list()).installations[0];
    const preview = await service.previewUpgrade(signFictionalPack(next));
    const body = { pack: preview.pack, expectedInstalledDigest: installed.digest, expectedInstalledRevision: 1, expectedDigest: preview.digest, expectedPreviewDigest: preview.previewDigest };
    await expect(service.upgrade({ ...body, pack: { ...preview.pack, signature: undefined } })).rejects.toThrow(UNSIGNED_PACK_MESSAGE);
    expect(preview.canApply).toBe(true); // Applying signed upgrades is covered in customer-pack-upgrades.test.ts.
  });
});

describe('per-client export', () => {
  async function seededOffice() {
    const a = office('a', { officeSettings: async () => ({ businessCode: 'FICTIONAL-AUSTON', csvColumnMapping: { identity: 'Property', rentLanded: 'Rent', [SEEDED.token]: SEEDED.ledger } as never,
      loops: [{ id: 'morning-arrears', schedule: { type: 'daily', time: '07:30', weekdays: [1, 2, 3, 4, 5], timezone: 'Australia/Brisbane', tenant: SEEDED.tenant } as never, enabled: true } as never,
        { id: 'recipe-wf-austin-accounts-inbox-triage', schedule: { type: 'daily', time: '08:00', weekdays: [1] } },
        { id: 'recipe-wf-local-only-tenant-chase', schedule: { type: 'daily', time: '09:00', weekdays: [2] } }],
      tenant: SEEDED.tenant, sessionToken: SEEDED.token }) as never });
    await install(a.service, austinCustomerPack());
    // Local records the office holds: edited plans, desk ledger, a session token and mailbox.
    a.setRecipes(a.recipes().map(recipe => ({ ...recipe, description: `${recipe.description} Chase ${SEEDED.tenant} for ${SEEDED.ledger}.`, status: 'active', planApprovedAt: 1, approvedRevision: 1, schedule: { type: 'daily', time: '07:00', weekdays: [1] } } as Recipe)));
    await mkdir(join(a.root, 'vault'), { recursive: true });
    await writeFile(join(a.root, 'desk.json'), JSON.stringify({ properties: [{ tenant: SEEDED.tenant, ledger: SEEDED.ledger }] }));
    await writeFile(join(a.root, 'vault', 'session.json'), JSON.stringify({ token: SEEDED.token, mailbox: SEEDED.mailbox }));
    return a;
  }

  it('exports workflows, recipes, the REI site map and loop clocks with no client data or REI account marker', async () => {
    const a = await seededOffice();
    const reply = await a.service.handle('/api/customer-packs/austin-office/client-export', 'GET');
    const exported = reply!.body as CustomerPack, text = JSON.stringify(exported);
    for (const value of [...Object.values(SEEDED), 'FICTIONAL-AUSTON']) expect(text).not.toContain(value);
    expect(exported.signature).toBeUndefined();
    expect(Object.keys(exported.files!).sort()).toEqual(['office/settings.json', 'rei/recipes.json', 'rei/site-map.json']);
    expect(exported.recipes.map(recipe => recipe.id)).toEqual(austinCustomerPack().recipes.map(recipe => recipe.id));
    expect(exported.recipes.every(recipe => recipe.schedule === null)).toBe(true);
    const settings = JSON.parse(exported.files!['office/settings.json']!) as CustomerPackOfficeSettings;
    expect(settings).toEqual({ version: 1, kind: 'office-settings',
      loops: [{ id: 'morning-arrears', enabled: false, schedule: { type: 'daily', time: '07:30', weekdays: [1, 2, 3, 4, 5], timezone: 'Australia/Brisbane' } },
        { id: 'recipe-wf-austin-accounts-inbox-triage', enabled: false, schedule: { type: 'daily', time: '08:00', weekdays: [1] } }] });
    // The unsigned export is not installable anywhere until the publisher signs it.
    const b = office('b-unsigned');
    await expect(install(b.service, exported)).rejects.toThrow(BUILT_IN_MISMATCH_MESSAGE);
  });

  it('round-trips honestly: what one office exports, a second office imports and re-exports unchanged', async () => {
    const a = await seededOffice();
    const exported = await a.service.clientExport('austin-office');
    let applied: CustomerPackOfficeSettings['loops'] = [];
    const b = office('b-roundtrip', { applyLoops: async loops => { applied = loops; }, officeSettings: async () => ({ loops: applied.map(({ id, schedule }) => ({ id, schedule })) }) });
    await install(b.service, signFictionalPack(exported));
    expect(await b.service.clientExport('austin-office')).toEqual(exported);
  });

  it('installs the signed export into a second office with every loop off', async () => {
    const a = await seededOffice();
    const exported = await a.service.clientExport('austin-office');
    const b = office('b');
    const installed = await install(b.service, signFictionalPack(exported));
    expect(installed).toMatchObject({ id: 'austin-office', localReady: true });
    expect(b.recipes().map(recipe => [recipe.status, recipe.schedule, recipe.approvedRevision])).toEqual(exported.recipes.map(() => ['shadow', null, null]));
    const reexport = await b.service.clientExport('austin-office');
    const settings = JSON.parse(reexport.files!['office/settings.json']!) as CustomerPackOfficeSettings;
    expect(settings.loops).toEqual([]);
    expect(reexport.files!['rei/site-map.json']).toBe(exported.files!['rei/site-map.json']);
    // A pack cannot switch a loop on, even when signed.
    const on = JSON.parse(exported.files!['office/settings.json']!); on.loops[0].enabled = true;
    await expect(install(office('c').service, signFictionalPack({ ...exported, files: { ...exported.files, 'office/settings.json': JSON.stringify(on) } }))).rejects.toThrow(/switched off/);
  });
});
