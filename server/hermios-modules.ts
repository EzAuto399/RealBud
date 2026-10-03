import {
  parseConfigureHermiosModuleInput,
  parseHermiosModulesSnapshot,
  parseHermiosProfile,
  type ConfigureHermiosModuleInput,
  type HermiosModulesSnapshot,
} from '../shared/hermios-modules.ts';

/** Host-owned identity only. No credentials, display-name matching or worker grants. */
export interface HermiosMemberBinding {
  connectionId: string;
  connectionRevision: string;
  companyId: string;
  memberId: string;
  profileId: string;
  workspaceId: string;
}

export type HermiosModuleCall =
  | { name: 'get_hermios_profile' | 'read_hermios_modules_v2'; arguments: Record<string, never> }
  | { name: 'configure_hermios_module_v2'; arguments: ConfigureHermiosModuleInput };

/**
 * Integration seam, not an authenticated transport implementation. The host must
 * derive currentBinding from its verified member session and explicit connection.
 * connectionRevision is a selection generation: never reuse it after reconnect,
 * account/member switch or A -> B -> A. Clear this adapter on those transitions.
 * call must pin credentials to this exact binding and recheck current membership
 * before dispatch; it must never retry mutations. Do not expose this as a Bud tool.
 */
export interface HermiosModulesHost {
  currentBinding(): HermiosMemberBinding | null;
  call(binding: Readonly<HermiosMemberBinding>, request: HermiosModuleCall): Promise<unknown>;
}

type ErrorCode = 'not_bound' | 'binding_changed' | 'busy' | 'invalid_response' |
  'read_failed' | 'read_required' | 'invalid_input' | 'changed' | 'not_allowed' | 'outcome_unknown';

export class HermiosModulesError extends Error {
  readonly code: ErrorCode;
  readonly outcomeUncertain: boolean;
  constructor(code: ErrorCode, message: string, outcomeUncertain = false) {
    super(message);
    this.code = code;
    this.outcomeUncertain = outcomeUncertain;
    this.name = 'HermiosModulesError';
  }
}

export interface HermiosModulesRead {
  binding: HermiosMemberBinding;
  snapshot: HermiosModulesSnapshot;
}

const bindingKeys = ['connectionId', 'connectionRevision', 'companyId', 'memberId', 'profileId', 'workspaceId'] as const;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function bindingCopy(value: HermiosMemberBinding | null): HermiosMemberBinding | null {
  if (!object(value) || Object.keys(value).length !== bindingKeys.length ||
      !bindingKeys.every(key => typeof value[key] === 'string' && value[key].trim().length > 0 &&
        value[key].length <= 300 && !/[\u0000-\u001f\u007f]/.test(value[key]))) return null;
  return { ...value } as unknown as HermiosMemberBinding;
}

function sameBinding(a: HermiosMemberBinding | null, b: HermiosMemberBinding): boolean {
  return !!a && bindingKeys.every(key => a[key] === b[key]);
}

// Text is not a data fallback: read_hermios_modules returns only a summary there.
// Error text can also follow a committed configuration; it is never parsed as a
// definitive conflict or proof that no mutation occurred.
function structured(result: unknown): unknown {
  if (!object(result) || result.isError !== false || !object(result.structuredContent)) {
    throw new HermiosModulesError('invalid_response', 'Hermios returned an unconfirmed result. Refresh the module list.');
  }
  return result.structuredContent;
}

/** Source-only adapter. No route, UI wiring, credential lookup, storage or retries. */
export function createHermiosModulesAdapter(host: HermiosModulesHost) {
  let epoch = 0;
  let busy = false;
  let cached: HermiosModulesRead | null = null;

  function current(): HermiosMemberBinding | null {
    try { return bindingCopy(host.currentBinding()); } catch { return null; }
  }

  function clear() {
    epoch += 1;
    cached = null;
  }

  function capture(): { binding: HermiosMemberBinding; epoch: number } {
    const binding = current();
    if (!binding) {
      clear();
      throw new HermiosModulesError('not_bound', 'Connect a verified Hermios account for this company member first.');
    }
    if (cached && !sameBinding(cached.binding, binding)) clear();
    return { binding, epoch };
  }

  function assertCurrent(context: ReturnType<typeof capture>) {
    if (context.epoch !== epoch || !sameBinding(current(), context.binding)) {
      clear();
      throw new HermiosModulesError('binding_changed', 'The company member or Hermios connection changed. Refresh modules.');
    }
  }

  async function call(context: ReturnType<typeof capture>, request: HermiosModuleCall) {
    assertCurrent(context);
    const result = await host.call(Object.freeze({ ...context.binding }), structuredClone(request));
    assertCurrent(context);
    return structured(result);
  }

  function checkedSnapshot(value: unknown, context: ReturnType<typeof capture>): HermiosModulesSnapshot {
    const snapshot = parseHermiosModulesSnapshot(value);
    if (snapshot.profileId !== context.binding.profileId || snapshot.workspaceId !== context.binding.workspaceId) {
      throw new HermiosModulesError('binding_changed', 'Hermios returned a different organization or member. Reconnect before continuing.');
    }
    return snapshot;
  }

  async function verify(context: ReturnType<typeof capture>): Promise<HermiosModulesSnapshot> {
    const profile = parseHermiosProfile(await call(context, { name: 'get_hermios_profile', arguments: {} }));
    if (profile.id !== context.binding.profileId || profile.workspaceId !== context.binding.workspaceId) {
      throw new HermiosModulesError('binding_changed', 'The Hermios profile does not match this company member connection.');
    }
    return checkedSnapshot(await call(context, { name: 'read_hermios_modules_v2', arguments: {} }), context);
  }

  function readError(error: unknown): HermiosModulesError {
    return error instanceof HermiosModulesError ? error :
      new HermiosModulesError('read_failed', 'Hermios modules could not be verified. Refresh before making changes.');
  }

  return {
    clear,
    snapshot(): HermiosModulesRead | null {
      if (cached && !sameBinding(current(), cached.binding)) clear();
      return cached ? structuredClone(cached) : null;
    },
    async read(): Promise<HermiosModulesRead> {
      if (busy) throw new HermiosModulesError('busy', 'A module request is still in progress.');
      busy = true;
      cached = null;
      try {
        const context = capture();
        const snapshot = await verify(context);
        assertCurrent(context);
        cached = { binding: context.binding, snapshot };
        return structuredClone(cached);
      } catch (error) {
        cached = null;
        throw readError(error);
      } finally { busy = false; }
    },
    async configure(value: unknown): Promise<HermiosModulesRead> {
      if (busy) throw new HermiosModulesError('busy', 'A module request is still in progress.');
      let input: ConfigureHermiosModuleInput;
      try { input = parseConfigureHermiosModuleInput(value); } catch {
        throw new HermiosModulesError('invalid_input', 'Check the module preferences before saving.');
      }
      const context = capture();
      const reviewed = cached?.snapshot.modules.find(module => module.id === input.moduleId);
      if (!reviewed || cached?.snapshot.profileId !== input.expectedProfileId || reviewed.revision !== input.expectedRevision) {
        throw new HermiosModulesError('read_required', 'Refresh modules and review the current preferences before saving.');
      }
      busy = true;
      cached = null;
      let dispatched = false;
      try {
        // Repeat identity, role and access reads; the upstream service still owns
        // effect-time APPLICATIONS permission, commercial access and revision CAS.
        const fresh = await verify(context);
        const module = fresh.modules.find(row => row.id === input.moduleId);
        if (!module || fresh.profileId !== input.expectedProfileId || module.revision !== input.expectedRevision) {
          throw new HermiosModulesError('changed', 'Module preferences changed. Refresh and review your draft before saving again.');
        }
        const configurationChanged = input.configuration.displayName !== module.configuration.displayName ||
          input.configuration.industry !== module.configuration.industry ||
          input.configuration.instructions !== module.configuration.instructions;
        if (!fresh.canConfigure || module.availability !== 'pilot' ||
            ((input.enabled || configurationChanged) && !['enabled', 'disabled'].includes(module.state))) {
          throw new HermiosModulesError('not_allowed', 'This account cannot apply that module change with its current access.');
        }
        assertCurrent(context);
        dispatched = true;
        const snapshot = checkedSnapshot(await call(context, { name: 'configure_hermios_module_v2', arguments: input }), context);
        // The service reads its response after commit. A later revision may be a
        // concurrent edit; expose the current snapshot, not an exact-save claim.
        const saved = snapshot.modules.find(row => row.id === input.moduleId);
        if (!saved || saved.revision <= input.expectedRevision) throw new Error('Unconfirmed revision');
        assertCurrent(context);
        cached = { binding: context.binding, snapshot };
        return structuredClone(cached);
      } catch (error) {
        cached = null;
        if (dispatched) {
          throw new HermiosModulesError('outcome_unknown', 'The module change may have been saved. Refresh modules, compare the current preferences with your draft, then decide whether to retry.', true);
        }
        throw readError(error);
      } finally { busy = false; }
    },
  };
}
