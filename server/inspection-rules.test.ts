import { privateTempRoot } from './testing/private-fixture.ts';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInspectionRulesApi, createInspectionRulesStore, defaultInspectionRules, MAX_RULE_HISTORY, validateInspectionRules } from './inspection-rules.ts';
import { removeFixture } from './testing/private-fixture.ts';

const directories: string[] = [];
const store = async () => {
  const directory = privateTempRoot(join(tmpdir(), 'realbud-inspection-rules-')); directories.push(directory);
  const file = join(directory, 'inspection-rules.json');
  return { file, store: createInspectionRulesStore({ file, now: () => 1_000 }) };
};
afterEach(async () => { await Promise.all(directories.splice(0).map(path => removeFixture(path))); });

describe('inspection rules store', () => {
  it('starts from the confirmed six-month completed-date cycle', async () => {
    const { store: rules } = await store();
    expect(await rules.read()).toMatchObject({ revision: 0, rules: { cycleMonths: 6, cycleBasis: 'completed', inspectors: [] }, history: [] });
  });

  it('saves with a revision check, keeps replaced versions (bounded) and writes 0600', async () => {
    const { file, store: rules } = await store();
    const saved = await rules.save({ expectedRevision: 0, rules: { ...defaultInspectionRules(), inspectors: ['fictional-inspector-A'] } });
    expect(saved).toMatchObject({ revision: 1, history: [{ rules: defaultInspectionRules(), replacedAt: 1_000 }] });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    await expect(rules.save({ expectedRevision: 0, rules: defaultInspectionRules() })).rejects.toMatchObject({ status: 409 });
    for (let i = 1; i <= MAX_RULE_HISTORY + 2; i++) await rules.save({ expectedRevision: i, rules: { ...saved.rules, cycleMonths: (i % 12) + 1 } });
    const state = await rules.read();
    expect(state.history).toHaveLength(MAX_RULE_HISTORY);
    expect(state.history[0]!.rules.cycleMonths).toBe(((MAX_RULE_HISTORY + 1) % 12) + 1);
  });

  it('restores the last good copy when the saved file is damaged, keeping the damaged file', async () => {
    const { file, store: rules } = await store();
    const saved = await rules.save({ expectedRevision: 0, rules: { ...defaultInspectionRules(), inspectors: ['fictional-inspector-A'] } });
    await rules.save({ expectedRevision: 1, rules: { ...saved.rules, cycleMonths: 3 } });
    writeFileSync(file, '{"version":1', { mode: 0o600 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try { expect(await rules.read()).toMatchObject({ revision: 1, rules: { inspectors: ['fictional-inspector-A'] } }); } finally { warn.mockRestore(); }
    expect(readdirSync(dirname(file)).some(name => name.startsWith('inspection-rules.json.damaged-'))).toBe(true);
  });

  it('rejects invalid rules with a plain message and changes nothing', async () => {
    const { store: rules } = await store();
    expect(() => validateInspectionRules({ ...defaultInspectionRules(), cycleMonths: 0 })).toThrow('whole months');
    expect(() => validateInspectionRules({ ...defaultInspectionRules(), cycleBasis: 'booked' })).toThrow('completed or planned');
    expect(() => validateInspectionRules({ ...defaultInspectionRules(), workingDays: [] })).toThrow('working day');
    expect(() => validateInspectionRules({ ...defaultInspectionRules(), extra: 1 })).toThrow('need exactly');
    await expect(rules.save({ expectedRevision: 0, rules: { ...defaultInspectionRules(), dayStart: '25:00' } })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('09:00') });
    expect((await rules.read()).revision).toBe(0);
  });

  it('holds rule edits until the leased local commit finishes and uses the current queued revision', async () => {
    const { file, store: rules } = await store();
    const saved = await rules.save({ expectedRevision: 0, rules: { ...defaultInspectionRules(), inspectors: ['fictional-inspector-A'] } });
    let begin!: () => void, finish!: () => void;
    const started = new Promise<void>(resolve => { begin = resolve; }), released = new Promise<void>(resolve => { finish = resolve; });
    const commit = rules.withSnapshot(async state => { begin(); await released; return state; });
    await started;
    let editCompleted = false;
    const edit = rules.save({ expectedRevision: saved.revision, rules: { ...saved.rules, dailyCapacity: 2 } }).then(state => { editCompleted = true; return state; });
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(editCompleted).toBe(false);
      expect(JSON.parse(readFileSync(file, 'utf8')).revision).toBe(saved.revision);
    } finally { finish(); }
    expect((await commit).rules.dailyCapacity).toBe(saved.rules.dailyCapacity);
    const edited = await edit;
    expect(await rules.withSnapshot(async state => state)).toEqual(edited);
  });

  it('releases a rejected snapshot lease so the next rules edit can finish', async () => {
    const { store: rules } = await store();
    await expect(rules.withSnapshot(async () => { throw new Error('fictional plan commit refused'); })).rejects.toThrow('fictional plan commit refused');
    const saved = await rules.save({ expectedRevision: 0, rules: { ...defaultInspectionRules(), inspectors: ['fictional-inspector-A'] } });
    expect(saved.revision).toBe(1);
  });

  it('serves GET/PUT and holds writes during recovery', async () => {
    const { store: rules } = await store();
    let recovery = false;
    const api = createInspectionRulesApi({ store: rules, recovery: () => recovery });
    expect(await api('/api/other', 'GET')).toBeNull();
    expect((await api('/api/inspection-rules', 'GET'))!.body).toMatchObject({ revision: 0 });
    expect((await api('/api/inspection-rules', 'PUT', { expectedRevision: 0, rules: { ...defaultInspectionRules(), cycleMonths: 4 } }))!.body).toMatchObject({ revision: 1, rules: { cycleMonths: 4 } });
    recovery = true;
    await expect(api('/api/inspection-rules', 'PUT', { expectedRevision: 1, rules: defaultInspectionRules() })).rejects.toMatchObject({ status: 503 });
  });
});
