/** Hermios modules v2 transport data (`read_hermios_modules_v2`,
 * `configure_hermios_module_v2`; Hermios partner status, 2 October 2026). This
 * parser grants no connection, CRM, execution or billing authority.
 * Configuration instructions remain plain data. V1 is frozen upstream and is
 * not accepted here: a partner-owned policy reads as unavailable through v1. */
export const HERMIOS_MODULE_IDS = [
  'hermios.realbud', 'hermios.industry.real-estate', 'hermios.industry.accounting',
  'hermios.bud.collaboration', 'hermios.automation.advanced', 'hermios.private-extension',
] as const;
export type HermiosModuleId = typeof HERMIOS_MODULE_IDS[number];
/** `id` is the per-member membership identity; `workspaceId` (UUID) is the
 * organization binding and the key for cross-member record locks. */
export interface HermiosProfile { id: string; workspaceId: string; name?: string; email?: string; nickname?: string }
export interface HermiosModuleConfiguration {
  displayName: string;
  industry: 'general' | 'real-estate' | 'accounting';
  instructions: string;
}
export interface HermiosModuleView {
  id: HermiosModuleId;
  name: string;
  description: string;
  category: 'integration' | 'industry' | 'automation' | 'custom';
  availability: 'pilot' | 'planned';
  state: 'enabled' | 'disabled' | 'requires_access' | 'expired' | 'denied' | 'coming_soon';
  enabled: boolean;
  revision: number;
  grantSource: 'operator' | 'trial' | 'partner' | null;
  /** 'realbud' when RealBud is the module's billing owner. */
  billingOwner: 'realbud' | null;
  expiresAt: string | null;
  configuration: HermiosModuleConfiguration;
}
export interface HermiosModulesSnapshot {
  schemaVersion: 2;
  profileId: string;
  workspaceId: string;
  workspaceName: string;
  canConfigure: boolean;
  modules: HermiosModuleView[];
}
export interface ConfigureHermiosModuleInput {
  moduleId: HermiosModuleId;
  expectedProfileId: string;
  expectedRevision: number;
  enabled: boolean;
  configuration: HermiosModuleConfiguration;
}

const invalid = (): never => { throw new Error('The Hermios module data is invalid. Refresh the connected account before continuing.'); };
function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid();
  if (!required.every(key => Object.hasOwn(value, key)) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !required.includes(key) && !optional.includes(key))) return invalid();
  return value as Record<string, unknown>;
}
const string = (value: unknown): string => typeof value === 'string' ? value : invalid();
const bool = (value: unknown): boolean => typeof value === 'boolean' ? value : invalid();
const revision = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : invalid();
function member<T extends string>(value: unknown, choices: readonly T[]): T {
  return typeof value === 'string' && choices.includes(value as T) ? value as T : invalid();
}
// These patterns are copied from Hermios's generated v1 JSON schema. Preserve
// UUID spelling and the UTC date string; neither identifies an account by email.
const UUID = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;
const UTC_DATE_TIME = /^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z))$/;
const uuid = (value: unknown): string => typeof value === 'string' && UUID.test(value) ? value : invalid();
const expiresAt = (value: unknown): string | null => value === null ? null : typeof value === 'string' && UTC_DATE_TIME.test(value) ? value : invalid();

function configuration(value: unknown): HermiosModuleConfiguration {
  const input = exact(value, ['displayName', 'industry', 'instructions']);
  const displayName = string(input.displayName).trim(), instructions = string(input.instructions).trim();
  if (displayName.length > 80 || instructions.length > 4000) return invalid();
  return { displayName, industry: member(input.industry, ['general', 'real-estate', 'accounting']), instructions };
}

/** Identity is the opaque id. Metadata is display-only and is never matched. */
export function parseHermiosProfile(value: unknown): HermiosProfile {
  const input = exact(value, ['id', 'workspaceId'], ['name', 'email', 'nickname']), id = string(input.id);
  if (!/\S/.test(id)) return invalid();
  const result: HermiosProfile = { id, workspaceId: uuid(input.workspaceId) };
  for (const key of ['name', 'email', 'nickname'] as const) if (Object.hasOwn(input, key)) result[key] = string(input[key]);
  return result;
}

function moduleView(value: unknown): HermiosModuleView {
  const input = exact(value, ['id', 'name', 'description', 'category', 'availability', 'state', 'enabled', 'revision', 'grantSource', 'billingOwner', 'expiresAt', 'configuration']);
  const state = member(input.state, ['enabled', 'disabled', 'requires_access', 'expired', 'denied', 'coming_soon']);
  const availability = member(input.availability, ['pilot', 'planned']), enabled = bool(input.enabled);
  // Upstream gives a current deny precedence over planned/coming_soon. Do not
  // recompute expiry here: the remote state is a snapshot, not local authority.
  if (enabled !== (state === 'enabled') || (availability === 'planned' && state !== 'coming_soon' && state !== 'denied') || (availability === 'pilot' && state === 'coming_soon')) return invalid();
  return {
    id: member(input.id, HERMIOS_MODULE_IDS), name: string(input.name), description: string(input.description),
    category: member(input.category, ['integration', 'industry', 'automation', 'custom']), availability, state, enabled,
    revision: revision(input.revision), grantSource: input.grantSource === null ? null : member(input.grantSource, ['operator', 'trial', 'partner'] as const),
    billingOwner: input.billingOwner === null ? null : member(input.billingOwner, ['realbud'] as const),
    expiresAt: expiresAt(input.expiresAt), configuration: configuration(input.configuration),
  };
}

export function parseHermiosModulesSnapshot(value: unknown): HermiosModulesSnapshot {
  const input = exact(value, ['schemaVersion', 'profileId', 'workspaceId', 'workspaceName', 'canConfigure', 'modules']);
  if (input.schemaVersion !== 2 || !Array.isArray(input.modules) || input.modules.length > HERMIOS_MODULE_IDS.length) return invalid();
  const modules = input.modules.map(moduleView);
  if (new Set(modules.map(module => module.id)).size !== modules.length) return invalid();
  return { schemaVersion: 2, profileId: uuid(input.profileId), workspaceId: uuid(input.workspaceId), workspaceName: string(input.workspaceName), canConfigure: bool(input.canConfigure), modules };
}

/** Configuration requests carry a caller-reviewed revision and profile binding.
 * Parsing does not establish permission to submit them or perform any work. */
export function parseConfigureHermiosModuleInput(value: unknown): ConfigureHermiosModuleInput {
  const input = exact(value, ['moduleId', 'expectedProfileId', 'expectedRevision', 'enabled', 'configuration']);
  return { moduleId: member(input.moduleId, HERMIOS_MODULE_IDS), expectedProfileId: uuid(input.expectedProfileId), expectedRevision: revision(input.expectedRevision), enabled: bool(input.enabled), configuration: configuration(input.configuration) };
}
