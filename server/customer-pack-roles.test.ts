// Auston role packs (Kevin's accounts, Sherry's property management), their
// loops applied on install, and packs offered by the office website.
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { Recipe } from '../shared/contracts.ts';
import { parseOfficePacks, type CustomerPackOfficeSettings, type OfficePacksSource, type OfficePacksView } from '../shared/customer-packs.ts';
import { workflowRecipeId } from '../shared/agency-workflow-packs.ts';
import { createAustinPack, loadAustinPack } from './austin-pack.ts';
import { austinAccountsCustomerPack, austinPropertyCustomerPack } from './customer-pack-definition.ts';
import { createCustomerPackService, validateCustomerPack } from './customer-packs.ts';
import { createInspectionRulesStore } from './inspection-rules.ts';
import { createMaintenanceReviewStore } from './maintenance-review.ts';
import { CHANGED_PACK_MESSAGE, UNSIGNED_PACK_MESSAGE } from './pack-signing.ts';
import { LoopManager } from './routines.ts';
import { FICTIONAL_PACK_KEYS, signFictionalPack } from './testing/pack-publisher.ts';
import { privateTempRoot, removeFixture } from './testing/private-fixture.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const settingsOf = (pack: { files?: Record<string, string> }) => JSON.parse(pack.files!['office/settings.json']!) as CustomerPackOfficeSettings;
// Tuesday 6 October 2026, 09:00 in Brisbane.
const NOW = Date.parse('2026-10-06T09:00:00+10:00');
const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

function office(options: { officePacks?: () => Promise<OfficePacksSource> } = {}) {
  const dir = privateTempRoot(join(realpathSync(tmpdir()), 'rb-role-packs-'));
  cleanup.push(() => removeFixture(dir));
  const loops = new LoopManager({ file: join(dir, 'loops.json'), hostTimezone: 'UTC', now: () => NOW, execute: async () => ({ ok: true, detail: 'Fictional run.' }) });
  cleanup.push(() => loops.close());
  const maintenance = createMaintenanceReviewStore({ file: join(dir, 'maintenance.json') });
  const austin = createAustinPack({ loops, maintenance, inspection: createInspectionRulesStore({ file: join(dir, 'inspection.json') }), file: join(dir, 'austin-pack.json'), now: () => NOW,
    officeTimeZone: async () => null, signals: async () => ({ gmail: false, redbark: false, tenants: 0, suppliers: 0 }) });
  let recipes: Recipe[] = [];
  const packs = createCustomerPackService({ directory: dir, profileDirectory: () => join(dir, 'profile'), workroomDirectory: () => join(dir, 'vault'), trustedKeys: FICTIONAL_PACK_KEYS,
    listRecipes: () => recipes, saveRecipes: ((inputs: unknown[]) => { recipes.push(...inputs.map(raw => ({ ...(raw as object), revision: 1 } as Recipe))); return recipes; }) as never,
    resetRecipeApprovals: () => {}, applyLoops: loopsToApply => austin.applyPackLoops(loopsToApply), ...options });
  const install = async (pack: unknown) => packs.install(pack, (await packs.preview(pack)).digest);
  return { loops, maintenance, austin, packs, install, loop: (id: string) => loops.listLoops().find(item => item.id === id)! };
}

describe('Auston role packs', () => {
  it('match the published JSON byte for byte, validate and keep a stable digest', () => {
    for (const [file, build] of [['realbud-austin-accounts-v1.json', austinAccountsCustomerPack], ['realbud-austin-property-v1.json', austinPropertyCustomerPack]] as const) {
      const pack = validateCustomerPack(build());
      expect(readFileSync(join(root, 'pack/workflows/austin-office', file), 'utf8')).toBe(`${JSON.stringify(pack, null, 2)}\n`);
      expect(digest(validateCustomerPack(build()))).toBe(digest(pack));
      expect(pack.signature).toBeUndefined();
    }
  });

  it("gives Kevin W1–W3 and Sherry W4, the supplier check and W5, every loop off at the schedule file's Brisbane times", () => {
    const schedule = loadAustinPack();
    const accounts = validateCustomerPack(austinAccountsCustomerPack()), property = validateCustomerPack(austinPropertyCustomerPack());
    expect(accounts).toMatchObject({ id: 'austin-accounts', revision: 2, title: 'Auston accounts — Kevin' });
    expect(accounts.workflows.map(w => w.id)).toEqual(['bank-references', 'bills-calendar', 'morning-priorities']);
    expect(accounts.recipes).toHaveLength(4);
    expect(accounts.skills.map(s => s.id)).toEqual(['email-inbox-triage', 'rei-cloud-navigation', 'property-management']);
    expect(JSON.stringify(accounts.recipes)).toContain('realbud-austin-accounts-email-inbox-triage');
    expect(JSON.stringify(accounts.recipes)).not.toContain('realbud-austin-office-');
    for (const role of ['inbox-triage', 'invoice-review', 'bill-exceptions', 'bank-reference-prep'] as const) expect(accounts.recipes.map(r => r.id)).toContain(workflowRecipeId('austin-accounts', role));
    expect(property).toMatchObject({ id: 'austin-property', revision: 1, title: 'Auston property management — Sherry', skills: [] });
    expect(property.recipes.map(r => r.id)).toEqual(['wf-austin-maintenance-rehearsal-compare']);
    for (const [pack, ids] of [[accounts, ['bank-references', 'weekly-bills', 'inbound-triage']], [property, ['maintenance-review', 'rei-supplier-check', 'inspection-draft']]] as const) {
      const settings = settingsOf(pack);
      expect(settings.loops.map(l => l.id)).toEqual(ids);
      for (const loop of settings.loops) {
        const { type: _type, timezone, ...clock } = loop.schedule;
        expect(loop.enabled).toBe(false);
        expect(timezone).toBe('Australia/Brisbane');
        expect(clock, loop.id).toEqual(schedule.loops.find(l => l.loopId === loop.id)!.schedule);
      }
    }
  });
});

describe('installing a pack applies its loops', () => {
  it('sets only its own workflows to Brisbane time, every one off, and the checklist lists only them', async () => {
    const f = office();
    expect((await f.austin.view()).installed).toBeNull();
    await f.install(austinAccountsCustomerPack());
    for (const id of ['bank-references', 'weekly-bills', 'inbound-triage']) expect(f.loop(id), id).toMatchObject({ enabled: false, nextRunAt: null, schedule: { timezone: 'Australia/Brisbane' } });
    expect(f.loop('maintenance-review').schedule.timezone).toBeUndefined();
    const view = await f.austin.view();
    expect(view.installed).toMatchObject({ loopIds: ['bank-references', 'weekly-bills', 'inbound-triage'] });
    expect(view.loops.map(l => l.loopId)).toEqual(['bank-references', 'weekly-bills', 'inbound-triage']);
    expect(view.checklist.map(i => i.id)).toEqual(['gmail', 'redbark', 'rei', 'tenants', 'workflows']);
    expect(view.checklist.find(i => i.id === 'workflows')?.detail).toMatch(/^0 of 3 on/);
    // Sherry's pack on the same PC adds hers; the earlier ones stay listed.
    await f.install(austinPropertyCustomerPack());
    expect((await f.austin.view()).installed?.loopIds).toEqual(['bank-references', 'weekly-bills', 'inbound-triage', 'maintenance-review', 'rei-supplier-check', 'inspection-draft']);
    expect(f.loop('inspection-draft')).toMatchObject({ enabled: false, schedule: { timezone: 'Australia/Brisbane', monthly: 'first-weekday' } });
  });

  it('keeps a time the office changed and an on/off choice, and sets the month rule only once', async () => {
    const f = office();
    f.loops.patchClock('maintenance-review', { time: '10:45' });
    f.loops.patchClock('rei-supplier-check', { enabled: true });
    await f.install(austinPropertyCustomerPack());
    expect(f.loop('maintenance-review').schedule).toMatchObject({ time: '10:45' });
    expect(f.loop('maintenance-review').schedule.timezone).toBeUndefined();
    expect(f.loop('rei-supplier-check')).toMatchObject({ enabled: true, schedule: { timezone: 'Australia/Brisbane' } });
    expect((await f.maintenance.read()).rule).toEqual({ basis: 'receivedDate', span: 'calendarMonth' });
    // The office then chooses its own rule; importing again never overwrites it.
    const { ruleRevision } = await f.maintenance.read();
    await f.maintenance.setRule({ rule: { basis: 'invoiceDate', span: 'rolling30' }, expectedRevision: ruleRevision ?? 0 });
    await f.install(austinPropertyCustomerPack());
    expect((await f.maintenance.read()).rule).toEqual({ basis: 'invoiceDate', span: 'rolling30' });
  });

  it('says plainly when the pack installed but its workflow times could not be set', async () => {
    const dir = privateTempRoot(join(realpathSync(tmpdir()), 'rb-role-fail-'));
    cleanup.push(() => removeFixture(dir));
    const packs = createCustomerPackService({ directory: dir, profileDirectory: () => join(dir, 'profile'), workroomDirectory: () => join(dir, 'vault'),
      listRecipes: () => [], saveRecipes: (() => []) as never, applyLoops: async () => { throw new Error('Fictional schedule recovery'); } });
    const pack = austinPropertyCustomerPack();
    await expect(packs.install(pack, (await packs.preview(pack)).digest)).rejects.toThrow(/installed, but its workflow times could not be set/);
    expect((await packs.list()).installations.map(i => i.id)).toEqual(['austin-property']);
  });
});

describe('packs from your office', () => {
  const listing = (pack: object & { id?: unknown; revision?: unknown }, over: Record<string, unknown> = {}) => ({ id: String(pack.id), title: 'Website label', revision: Number(pack.revision), sha256: 'a'.repeat(64), pack, ...over });
  const ready = (...packs: ReturnType<typeof listing>[]) => async (): Promise<OfficePacksSource> => ({ state: 'ready', packs: parseOfficePacks({ version: 1, packs }) });

  it('offers only signed packs, under their signed title, and says why the others cannot be used', async () => {
    const signed = signFictionalPack(validateCustomerPack(austinAccountsCustomerPack()));
    const tampered = { ...signFictionalPack(validateCustomerPack(austinPropertyCustomerPack())), title: 'Changed after signing' };
    const unsignedBuiltIn = validateCustomerPack(austinPropertyCustomerPack());
    const f = office({ officePacks: ready(listing(signed), listing(tampered), listing(unsignedBuiltIn, { id: 'austin-property-copy' }), listing({ ...signed }, { revision: 9 }), listing({ format: 'not-a-pack' } as object, { id: 'garbled', revision: 1 })) });
    const result = await f.packs.handle('/api/customer-packs/office', 'GET');
    expect(result?.status).toBe(200);
    const body = result!.body as Extract<OfficePacksView, { state: 'ready' }>;
    expect(body.state).toBe('ready');
    expect(body.packs.map(p => [p.id, p.title, p.revision])).toEqual([['austin-accounts', 'Auston accounts — Kevin', 2]]);
    expect(body.packs[0].digest).toBe((await f.packs.preview(signed)).digest);
    expect(body.refused.map(r => r.id)).toEqual(['austin-property', 'austin-property-copy', 'austin-accounts', 'garbled']);
    expect(body.refused[0].reason).toBe(CHANGED_PACK_MESSAGE);
    // A pack identical to a built-in is still refused from the website without a signature.
    expect(body.refused[1].reason).toBe(UNSIGNED_PACK_MESSAGE);
    expect(body.refused[2].reason).toMatch(/does not match/);
    expect(body.refused[3].reason).toMatch(/\w/);
  });

  it('refuses an unsigned built-in copy outright and passes through not-linked or unavailable', async () => {
    const unsigned = validateCustomerPack(austinAccountsCustomerPack());
    const refusing = await office({ officePacks: ready(listing(unsigned)) }).packs.handle('/api/customer-packs/office', 'GET');
    expect(refusing?.body).toEqual({ state: 'ready', packs: [], refused: [{ id: 'austin-accounts', revision: 2, reason: UNSIGNED_PACK_MESSAGE }] });
    for (const state of ['not-linked', 'unavailable'] as const) expect((await office({ officePacks: async () => ({ state }) }).packs.handle('/api/customer-packs/office', 'GET'))?.body).toEqual({ state });
    expect((await office().packs.handle('/api/customer-packs/office', 'GET'))?.body).toEqual({ state: 'not-linked' });
  });

  it('still admits the role packs as built-ins from the app itself, and exports them for signing', async () => {
    const f = office();
    for (const build of [austinAccountsCustomerPack, austinPropertyCustomerPack]) {
      const exported = await f.packs.handle(`/api/customer-packs/${build().id}/export`, 'GET');
      expect(exported?.body).toEqual(validateCustomerPack(build()));
      expect((await f.packs.preview(exported!.body)).canInstall).toBe(true);
    }
    expect((await f.packs.handle('/api/customer-packs/not-built-in/export', 'GET'))?.status).toBe(404);
  });

  it('parses the website envelope strictly', () => {
    const good = { id: 'austin-accounts', title: 'Fictional', revision: 0, sha256: 'b'.repeat(64), pack: {} };
    expect(parseOfficePacks({ version: 1, packs: [good] })).toEqual([good]);
    for (const bad of [null, [], { version: 1 }, { version: 1, packs: [{ ...good, extra: 1 }] }, { version: 1, packs: [{ ...good, revision: -1 }] }, { version: 1, packs: [{ ...good, sha256: 'xyz' }] }, { version: 1, packs: [{ ...good, pack: [] }] }, { version: 1, packs: [{ ...good, id: 'Bad Id' }] }])
      expect(() => parseOfficePacks(bad)).toThrow('could not be read');
  });
});

