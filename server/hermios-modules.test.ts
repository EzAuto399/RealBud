import { describe, expect, it } from 'vitest';
import { createHermiosModulesAdapter, type HermiosMemberBinding, type HermiosModuleCall } from './hermios-modules.ts';

const profileId = '11111111-1111-4111-8111-111111111111';
const workspaceId = '22222222-2222-4222-8222-222222222222';
const otherId = '33333333-3333-4333-8333-333333333333';
const binding: HermiosMemberBinding = {
  connectionId: 'fictional-connection', connectionRevision: 'fictional-selection-1',
  companyId: 'fictional-company', memberId: 'fictional-member', profileId, workspaceId,
};
const configuration = { displayName: 'Fictional office', industry: 'real-estate', instructions: 'Prepare a draft only.' };
const change = () => ({ moduleId: 'hermios.realbud', expectedProfileId: profileId, expectedRevision: 2, enabled: true, configuration: { ...configuration } });
const snapshot = () => ({
  schemaVersion: 2, profileId, workspaceId, workspaceName: 'Fictional office', canConfigure: true,
  modules: [{ id: 'hermios.realbud', name: 'RealBud connection', description: 'Fictional pilot', category: 'integration',
    availability: 'pilot', state: 'disabled', enabled: false, revision: 2, grantSource: 'operator', billingOwner: null, expiresAt: null,
    configuration: { ...configuration } }],
});
const envelope = (value: unknown) => ({ isError: false, structuredContent: value, content: [{ type: 'text', text: 'Organization module availability and preferences.' }] });

function fixture() {
  let currentBinding: HermiosMemberBinding | null = { ...binding };
  let modules = snapshot();
  let profile: unknown = { id: profileId, workspaceId, email: 'fictional@example.invalid', nickname: 'Fictional office' };
  let intercept: ((request: HermiosModuleCall) => unknown | Promise<unknown>) | undefined;
  const calls: { binding: HermiosMemberBinding; request: HermiosModuleCall }[] = [];
  const adapter = createHermiosModulesAdapter({
    currentBinding: () => currentBinding,
    async call(bound, request) {
      calls.push({ binding: { ...bound }, request: structuredClone(request) });
      if (intercept) {
        const result = await intercept(request);
        if (result !== undefined) return result;
      }
      if (request.name === 'get_hermios_profile') return envelope(profile);
      if (request.name === 'configure_hermios_module_v2') {
        modules = { ...modules, modules: modules.modules.map(row => ({ ...row, revision: row.revision + 1,
          state: request.arguments.enabled ? 'enabled' : 'disabled', enabled: request.arguments.enabled,
          configuration: { ...request.arguments.configuration } })) };
      }
      return envelope(structuredClone(modules));
    },
  });
  return {
    adapter, calls,
    bind: (value: HermiosMemberBinding | null) => { currentBinding = value; },
    profile: (value: unknown) => { profile = value; },
    modules: (value: ReturnType<typeof snapshot>) => { modules = value; },
    intercept: (value: typeof intercept) => { intercept = value; },
    writes: () => calls.filter(call => call.request.name === 'configure_hermios_module_v2'),
  };
}

describe('Hermios module adapter foundation (fictional, no transport implementation)', () => {
  it('reads profile and modules bound to explicit member/workspace identities', async () => {
    const f = fixture();
    const result = await f.adapter.read();
    expect(result).toEqual({ binding, snapshot: snapshot() });
    expect(f.calls.map(call => call.request.name)).toEqual(['get_hermios_profile', 'read_hermios_modules_v2']);
    expect(f.calls.every(call => JSON.stringify(call.binding) === JSON.stringify(binding))).toBe(true);
    expect(result).not.toHaveProperty('connected');
  });

  it('does not call an unbound host or infer a binding from matching labels', async () => {
    const f = fixture();
    f.bind(null);
    await expect(f.adapter.read()).rejects.toMatchObject({ code: 'not_bound' });
    expect(f.calls).toHaveLength(0);
    f.bind(binding);
    f.profile({ id: otherId, workspaceId, email: 'fictional@example.invalid', nickname: 'Fictional office' });
    await expect(f.adapter.read()).rejects.toMatchObject({ code: 'binding_changed' });
    expect(f.calls).toHaveLength(1);
    // The same member in another workspace is a different binding too.
    f.profile({ id: profileId, workspaceId: otherId });
    await expect(f.adapter.read()).rejects.toMatchObject({ code: 'binding_changed' });
    expect(f.calls).toHaveLength(2);
    expect(f.adapter.snapshot()).toBeNull();
  });

  it.each(['profileId', 'workspaceId'] as const)('rejects a different snapshot %s', async key => {
    const f = fixture();
    f.modules({ ...snapshot(), [key]: otherId });
    await expect(f.adapter.read()).rejects.toMatchObject({ code: 'binding_changed' });
    expect(f.adapter.snapshot()).toBeNull();
  });

  it.each(['get_hermios_profile', 'read_hermios_modules_v2'] as const)('discards a switch during %s', async name => {
    const f = fixture();
    f.intercept(request => {
      if (request.name === name) f.bind({ ...binding, connectionRevision: 'fictional-selection-2' });
    });
    await expect(f.adapter.read()).rejects.toMatchObject({ code: 'binding_changed' });
    expect(f.adapter.snapshot()).toBeNull();
    expect(f.calls).toHaveLength(name === 'get_hermios_profile' ? 1 : 2);
  });

  it('invalidates a pending response even after the same account is reselected', async () => {
    const f = fixture();
    f.intercept(request => {
      if (request.name === 'read_hermios_modules_v2') {
        f.bind({ ...binding, memberId: 'fictional-other-member' });
        f.adapter.clear();
        f.bind({ ...binding });
      }
    });
    await expect(f.adapter.read()).rejects.toMatchObject({ code: 'binding_changed' });
    expect(f.adapter.snapshot()).toBeNull();
  });

  it('clears cached state when the company member changes', async () => {
    const f = fixture();
    await f.adapter.read();
    f.bind({ ...binding, memberId: 'fictional-other-member' });
    expect(f.adapter.snapshot()).toBeNull();
    await expect(f.adapter.configure(change())).rejects.toMatchObject({ code: 'read_required' });
    expect(f.writes()).toHaveLength(0);
  });

  it('never interprets text-only success, failed envelopes or unsupported payloads as module data', async () => {
    for (const result of [
      { isError: false, content: [{ type: 'text', text: JSON.stringify(snapshot()) }] },
      { isError: true, structuredContent: snapshot() },
      envelope({ ...snapshot(), schemaVersion: 1 }),
    ]) {
      const f = fixture();
      f.intercept(request => request.name === 'read_hermios_modules_v2' ? result : undefined);
      await expect(f.adapter.read()).rejects.toBeInstanceOf(Error);
      expect(f.adapter.snapshot()).toBeNull();
    }
  });

  it('clones results so consumers cannot edit cached permission or revision evidence', async () => {
    const f = fixture();
    const read = await f.adapter.read();
    read.binding.memberId = 'fictional-other-member';
    read.snapshot.modules[0].revision = 999;
    const cached = f.adapter.snapshot()!;
    cached.snapshot.canConfigure = false;
    expect(f.adapter.snapshot()).toEqual({ binding, snapshot: snapshot() });
  });

  it('requires a prior displayed read and exact revision before configuration', async () => {
    const f = fixture();
    await expect(f.adapter.configure(change())).rejects.toMatchObject({ code: 'read_required' });
    await f.adapter.read();
    await expect(f.adapter.configure({ ...change(), expectedRevision: 1 })).rejects.toMatchObject({ code: 'read_required' });
    expect(f.writes()).toHaveLength(0);
  });

  it('rejects unknown input keys before any request', async () => {
    const f = fixture();
    await expect(f.adapter.configure({ ...change(), tool: 'send_message' })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(f.calls).toHaveLength(0);
  });

  it('rechecks current profile and permission, then sends the exact normalized preference change once', async () => {
    const f = fixture();
    await f.adapter.read();
    const result = await f.adapter.configure({ ...change(), configuration: { ...configuration, displayName: '  Fictional office  ' } });
    expect(f.calls.map(call => call.request.name)).toEqual([
      'get_hermios_profile', 'read_hermios_modules_v2', 'get_hermios_profile', 'read_hermios_modules_v2', 'configure_hermios_module_v2',
    ]);
    expect(f.writes()).toEqual([{ binding, request: { name: 'configure_hermios_module_v2', arguments: change() } }]);
    expect(result.snapshot.modules[0].revision).toBe(3);
    expect(result.snapshot.modules[0].enabled).toBe(true);
    expect(result).not.toHaveProperty('connected');
  });

  it.each(['permission', 'expiry', 'denied', 'planned', 'revision'] as const)('holds a fresh %s change before dispatch', async condition => {
    const f = fixture();
    await f.adapter.read();
    const changed = snapshot();
    if (condition === 'permission') changed.canConfigure = false;
    if (condition === 'expiry') changed.modules[0].state = 'expired';
    if (condition === 'denied') changed.modules[0].state = 'denied';
    if (condition === 'planned') { changed.modules[0].availability = 'planned'; changed.modules[0].state = 'coming_soon'; }
    if (condition === 'revision') changed.modules[0].revision = 3;
    f.modules(changed);
    await expect(f.adapter.configure(change())).rejects.toMatchObject({ code: condition === 'revision' ? 'changed' : 'not_allowed' });
    expect(f.writes()).toHaveLength(0);
    expect(f.adapter.snapshot()).toBeNull();
  });

  it('allows only an inert disable with normalized saved values after access expiry', async () => {
    const f = fixture();
    const expired = snapshot();
    expired.modules[0].state = 'expired';
    f.modules(expired);
    await f.adapter.read();
    await f.adapter.configure({ ...change(), enabled: false, configuration: { ...configuration, displayName: '  Fictional office  ' } });
    expect(f.writes()).toHaveLength(1);
  });

  it.each(['expired', 'denied', 'requires_access'])('rejects changed preferences in %s before dispatch, including when disabling', async state => {
    for (const configurationChange of [
      { displayName: 'Fictional renamed office' }, { industry: 'accounting' }, { instructions: 'Different fictional preferences' },
    ]) {
      const f = fixture();
      const changed = snapshot();
      changed.modules[0].state = state;
      f.modules(changed);
      await f.adapter.read();
      await expect(f.adapter.configure({ ...change(), enabled: false, configuration: { ...configuration, ...configurationChange } }))
        .rejects.toMatchObject({ code: 'not_allowed', outcomeUncertain: false });
      expect(f.writes()).toHaveLength(0);
    }
  });

  it('returns a later post-commit snapshot without claiming exact submitted values still apply', async () => {
    const f = fixture();
    await f.adapter.read();
    f.intercept(request => {
      if (request.name !== 'configure_hermios_module_v2') return;
      const newer = snapshot();
      newer.modules[0].revision = 5;
      newer.modules[0].configuration.displayName = 'Fictional concurrent edit';
      return envelope(newer);
    });
    const result = await f.adapter.configure(change());
    expect(result.snapshot.modules[0].revision).toBe(5);
    expect(result.snapshot.modules[0].configuration.displayName).toBe('Fictional concurrent edit');
    expect(f.writes()).toHaveLength(1);
  });

  it.each(['tool-error', 'transport', 'malformed', 'unchanged', 'wrong-workspace', 'account-switch'] as const)(
    'holds %s after dispatch as uncertain and never replays it', async failure => {
      const f = fixture();
      await f.adapter.read();
      f.intercept(request => {
        if (request.name !== 'configure_hermios_module_v2') return;
        if (failure === 'tool-error') return { isError: true, content: [{ type: 'text', text: 'fictional commit succeeded, readback failed' }] };
        if (failure === 'transport') throw Object.assign(new Error('fictional sensitive transport detail'), { status: 403 });
        if (failure === 'malformed') return envelope({});
        if (failure === 'unchanged') return envelope(snapshot());
        if (failure === 'wrong-workspace') return envelope({ ...snapshot(), workspaceId: otherId });
        f.bind({ ...binding, connectionRevision: 'fictional-selection-2' });
      });
      await expect(f.adapter.configure(change())).rejects.toMatchObject({ code: 'outcome_unknown', outcomeUncertain: true });
      expect(f.adapter.snapshot()).toBeNull();
      await expect(f.adapter.configure(change())).rejects.toMatchObject({ code: 'read_required' });
      expect(f.writes()).toHaveLength(1);
    },
  );

  it('exposes only a safe local error on a read transport failure', async () => {
    const f = fixture();
    f.intercept(() => { throw new Error('fictional secret provider detail'); });
    await expect(f.adapter.read()).rejects.toMatchObject({ code: 'read_failed', outcomeUncertain: false });
    await expect(f.adapter.read()).rejects.not.toThrow('fictional secret provider detail');
    expect(f.adapter.snapshot()).toBeNull();
  });

  it('does not overlap a read or second write with a pending mutation', async () => {
    const f = fixture();
    await f.adapter.read();
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const writing = new Promise<void>(resolve => { started = resolve; });
    f.intercept(async request => {
      if (request.name === 'configure_hermios_module_v2') { started(); await waiting; }
    });
    const first = f.adapter.configure(change());
    await writing;
    await expect(f.adapter.read()).rejects.toMatchObject({ code: 'busy' });
    await expect(f.adapter.configure(change())).rejects.toMatchObject({ code: 'busy' });
    f.adapter.clear();
    release();
    await expect(first).rejects.toMatchObject({ code: 'outcome_unknown', outcomeUncertain: true });
    expect(f.writes()).toHaveLength(1);
    expect(f.adapter.snapshot()).toBeNull();
  });
});
