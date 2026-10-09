import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOnboardingHandler } from './onboarding.ts';
import * as privateJson from './private-json.ts';
import { parseOnboardingState, type OnboardingState } from '../shared/onboarding.ts';

const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'fictional-onboarding-'));
  directories.push(directory);
  let member = 'fictional-member-a';
  const options = { directory, workspaceId: 'fictional-workspace', memberKey: () => member };
  const handler = createOnboardingHandler(options);
  const read = async () => parseOnboardingState((await handler.handle('/api/onboarding', 'GET'))!.body);
  const write = (current: OnboardingState, stage: OnboardingState['stage']) => handler.handle('/api/onboarding', 'PUT', { expectedScope: current.scope, expectedRevision: current.revision, stage });
  return { directory, options, handler, read, write, member: (next: string) => { member = next; } };
}

describe('durable onboarding', () => {
  it('exposes the same physical setup scope without allocating or changing saved state', async () => {
    const f = await fixture();
    const identity = f.handler.currentScope();
    expect(identity).toMatch(/^[a-f0-9]{64}$/);
    expect(await readdir(f.directory)).toEqual([]);
    expect(createOnboardingHandler(f.options).currentScope()).toBe(identity);
    const fresh = await f.read();
    expect(fresh.scope).toBe(identity);
    const rules = parseOnboardingState((await f.write(fresh, 'office-rules'))!.body);
    const file = join(f.directory, 'onboarding', `${identity}.json`), bytes = await readFile(file);
    expect(f.handler.currentScope()).toBe(identity);
    expect(await readFile(file)).toEqual(bytes);
    expect(await f.read()).toEqual(rules);
    expect(Object.keys(rules).sort()).toEqual(['revision', 'scope', 'stage', 'version']);
  });
  it('binds physical workspace and private member independently of book revisions', async () => {
    const f = await fixture(), first = f.handler.currentScope();
    const replacement = createOnboardingHandler({ ...f.options, workspaceId: 'fictional-replacement-workspace' });
    expect(replacement.currentScope()).not.toBe(first);
    const originalState = await f.read();
    const replacementState = parseOnboardingState((await replacement.handle('/api/onboarding', 'GET'))!.body);
    expect(originalState.revision).toBe(replacementState.revision);
    expect(replacementState.scope).toBe(replacement.currentScope());
    const files = await readdir(join(f.directory, 'onboarding'));
    expect((await replacement.handle('/api/onboarding', 'PUT', { expectedScope: first, expectedRevision: replacementState.revision, stage: 'office-rules' }))!.status).toBe(409);
    expect(await readdir(join(f.directory, 'onboarding'))).toEqual(files);
    f.member('fictional-private-member-b');
    expect(f.handler.currentScope()).not.toBe(first);
    f.member('fictional-member-a');
    expect(f.handler.currentScope()).toBe(first);
  });
  it('resumes interrupted rules and completed setup after handler/service recreation', async () => {
    const f = await fixture();
    const fresh = await f.read();
    expect(fresh.stage).toBe('profile');
    expect((await f.write(fresh, 'complete'))!.status).toBe(409);
    const rules = parseOnboardingState((await f.write(fresh, 'office-rules'))!.body);
    expect((await createOnboardingHandler(f.options).handle('/api/onboarding', 'GET'))!.body).toEqual(rules);
    const complete = parseOnboardingState((await f.write(rules, 'complete'))!.body);
    expect((await createOnboardingHandler(f.options).handle('/api/onboarding', 'GET'))!.body).toEqual(complete);
  });
  it('reconciles a lost finish reply and prevents stale completion regressions', async () => {
    const f = await fixture(), fresh = await f.read();
    const rules = parseOnboardingState((await f.write(fresh, 'office-rules'))!.body);
    const completed = await f.write(rules, 'complete');
    expect(await f.write(rules, 'complete')).toEqual(completed);
    expect((await f.write(rules, 'profile'))!.status).toBe(409);
    expect((await f.write(parseOnboardingState(completed!.body), 'profile'))!.status).toBe(409);
  });
  it('preserves separate recovery escape without claiming completed onboarding', async () => {
    const f = await fixture(), fresh = await f.read();
    const recovery = parseOnboardingState((await f.write(fresh, 'recovery'))!.body);
    expect(recovery.stage).toBe('recovery');
    expect((await createOnboardingHandler(f.options).handle('/api/onboarding', 'GET'))!.body).toEqual(recovery);
  });
  it('does not carry another member or workspace completion across', async () => {
    const f = await fixture(), fresh = await f.read();
    const rules = parseOnboardingState((await f.write(fresh, 'office-rules'))!.body);
    await f.write(rules, 'complete');
    f.member('fictional-member-b');
    expect((await f.read()).stage).toBe('profile');
    expect((await f.write(rules, 'complete'))!.status).toBe(409);
    expect(parseOnboardingState((await createOnboardingHandler({ ...f.options, workspaceId: 'fictional-other' }).handle('/api/onboarding', 'GET'))!.body).stage).toBe('profile');
    f.member('fictional-member-a');
    expect((await f.read()).stage).toBe('complete');
  });
  it('rechecks the member after asynchronous reading before saving', async () => {
    const f = await fixture(), fresh = await f.read();
    const original = privateJson.readPrivateJson;
    vi.spyOn(privateJson, 'readPrivateJson').mockImplementationOnce(async (...args) => { const result = await original(...args); f.member('fictional-member-b'); return result; });
    expect((await f.write(fresh, 'office-rules'))!.status).toBe(409);
    f.member('fictional-member-a');
    expect((await f.read()).stage).toBe('profile');
  });
  it('serializes two windows so stale writes cannot overwrite their progress', async () => {
    const f = await fixture(), fresh = await f.read();
    const [rules, recovery] = await Promise.all([f.write(fresh, 'office-rules'), f.write(fresh, 'recovery')]);
    expect(rules!.status).toBe(200); expect(recovery!.status).toBe(409);
    expect((await f.read()).stage).toBe('office-rules');
  });
  it('holds corrupted state and preserves its exact bytes', async () => {
    const f = await fixture(), fresh = await f.read();
    const file = join(f.directory, 'onboarding', `${fresh.scope}.json`);
    await writeFile(file, '{broken', { mode: 0o600 });
    expect((await f.handler.handle('/api/onboarding', 'GET'))!.status).toBe(503);
    expect((await f.write(fresh, 'office-rules'))!.status).toBe(503);
    expect(await readFile(file, 'utf8')).toBe('{broken');
  });
  it('does not expose private storage errors even when they carry an HTTP status', async () => {
    const f = await fixture();
    vi.spyOn(privateJson, 'readPrivateJson').mockRejectedValueOnce(Object.assign(new Error('/synthetic/private/member-state'), { status: 503 }));
    const result = await f.handler.handle('/api/onboarding', 'GET');
    expect(result!.status).toBe(503);
    expect(JSON.stringify(result!.body)).not.toContain('/synthetic/private');
  });
  it('requires exact versioned state and caller revision/scope', async () => {
    const f = await fixture(), fresh = await f.read();
    for (const body of [{ stage: 'complete' }, { expectedScope: fresh.scope, expectedRevision: 0, stage: 'complete', extra: true }, { expectedScope: fresh.scope, expectedRevision: 0, stage: 'unknown' }]) {
      expect((await f.handler.handle('/api/onboarding', 'PUT', body))!.status).toBe(400);
    }
  });
});
