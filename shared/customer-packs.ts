import type { CsvColumnMapping, LoopSchedule, Recipe } from './contracts.ts';

export type CustomerPackCheckId = 'worker' | 'mail-account' | 'browser-account' | 'bank-mapping' | 'bill-register' | 'input-coverage' | 'timezone' | 'workflow-acceptance';
export type CustomerPackCheck = { id: CustomerPackCheckId | 'installation'; label: string; state: 'passed' | 'needed' | 'unknown'; detail: string; nextAction: string };
export type CustomerPackRecipe = Pick<Recipe, 'id' | 'title' | 'description' | 'steps' | 'evidence' | 'capabilities' | 'limits' | 'siteNotes' | 'schedule' | 'allowedOrigins'>;
export interface CustomerPack {
  format: 'realbud-customer-pack'; version: 1; id: string; revision: number; title: string;
  workflows: { id: string; title: string; recipeIds: string[]; checks: CustomerPackCheckId[] }[];
  recipes: CustomerPackRecipe[];
  /** Text-only native skill instructions. Paths and executable assets are never accepted. */
  skills: { id: string; name: string; description: string; instructions: string; license: string }[];
  dependencies: { runtime: 'hermes-property'; mode: 'supplied-source-preparation'; schedules: 'off'; permissions: 'local-review-required' };
  /** Optional data files, by allowlisted path (CUSTOMER_PACK_FILES). Text only. */
  files?: Partial<Record<CustomerPackFile, string>>;
  /** RealBud publisher signature (server/pack-signing.ts). Built-in packs ship inside the signed app and carry none. */
  signature?: { algorithm: 'ed25519'; keyId: string; value: string };
}
/** The only data files a pack may carry. */
export const CUSTOMER_PACK_FILES = ['rei/recipes.json', 'rei/site-map.json', 'office/settings.json'] as const;
export type CustomerPackFile = typeof CUSTOMER_PACK_FILES[number];
/** `office/settings.json`: office setup only. Loops always arrive off. */
export interface CustomerPackOfficeSettings {
  version: 1; kind: 'office-settings';
  /** The business code in REI's top bar. */
  rei?: { businessCode: string };
  csvColumnMapping?: CsvColumnMapping;
  /** Installing a pack applies these through server/austin-pack.ts: never on, office-changed clocks kept. */
  loops: { id: string; enabled: false; schedule: LoopSchedule }[];
}
export interface CustomerPackPreview {
  pack: CustomerPack; digest: string; additions: string[]; kept: string[]; conflicts: string[];
  skills: { id: string; state: 'missing' | 'identical' | 'conflict' }[];
  canInstall: boolean;
}
export interface CustomerPackInstallation {
  id: string; title: string; revision: number; digest: string;
  state: 'installed' | 'recovery-required'; installedAt: string;
  checks: CustomerPackCheck[]; localReady: boolean; workflows: CustomerPack['workflows'];
  receipt: { addedRecipes: string[]; installedSkills: string[]; preservedRecipes: string[]; note: string };
  installationRevision?: number;
  pendingChange?: { action: 'upgrade' | 'rollback'; targetRevision: number; targetDigest: string; previewDigest: string };
  history?: { installationRevision: number; revision: number; digest: string; title: string; savedAt: string }[];
  retiredRecipes?: string[];
  archivedHistory?: { head: string; batches: number; configurations: number; throughRevision: number };
  pendingArchive?: { previewDigest: string };

}

export interface CustomerPackChangePreview {
  action: 'upgrade' | 'rollback'; pack: CustomerPack; digest: string;
  installedDigest: string; installedRevision: number; previewDigest: string;
  rollbackRevision?: number;
  recipes: { id: string; action: 'add' | 'update' | 'preserve' | 'retire'; before: CustomerPackRecipe | null; after: CustomerPackRecipe }[];
  skills: { id: string; action: 'add' | 'update' | 'preserve' | 'retire'; overrideKept: boolean }[];
  instructions: { key: string; before: string | null; after: string | null }[];
  conflicts: string[]; canApply: boolean;
}

export interface PackSkillProposal {
  id: string; pendingDigest: string; packId: string | null; skillId: string | null; name: string;
  state: 'reviewable' | 'unsupported'; reason: string; current: string | null; proposed: string | null;
  currentDigest: string | null; activeRevision: number; origin: string;
}
export interface PackSkillRevision {
  packId: string; skillId: string; revision: number; digest: string; active: boolean; createdAt: string;
  content: string; reason: string;
}

/** One entry of GET /api/installations/packs on the office website. The website
 * is untrusted: `pack` is unchecked JSON until the desktop admits it with a
 * valid pinned signature, and `sha256` (of the website's stored bytes) is
 * informational only. */
export interface OfficePackListing { id: string; title: string; revision: number; sha256: string; pack: unknown }
export const OFFICE_PACKS_MAX = 20;
/** The most of a website answer the desktop reads. */
export const OFFICE_PACKS_MAX_BYTES = 5_000_000;
/** Strict envelope `{version: 1, packs: [...]}`; unknown fields are refused. */
export function parseOfficePacks(value: unknown): OfficePackListing[] {
  const bad = (): never => { throw new Error('The list of packs from your office could not be read.'); };
  const record = (item: unknown, keys: string[]): Record<string, unknown> => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== keys.length || !keys.every(key => Object.hasOwn(item, key))) return bad();
    return item as Record<string, unknown>;
  };
  const root = record(value, ['version', 'packs']);
  if (root.version !== 1 || !Array.isArray(root.packs) || root.packs.length > OFFICE_PACKS_MAX) return bad();
  return root.packs.map(raw => {
    const entry = record(raw, ['id', 'title', 'revision', 'sha256', 'pack']);
    if (typeof entry.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(entry.id) || typeof entry.title !== 'string' || !entry.title.trim() || entry.title.length > 200 ||
      !Number.isSafeInteger(entry.revision) || Number(entry.revision) < 0 || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      !entry.pack || typeof entry.pack !== 'object' || Array.isArray(entry.pack)) return bad();
    return { id: entry.id, title: entry.title, revision: Number(entry.revision), sha256: entry.sha256, pack: entry.pack };
  });
}
export type OfficePacksSource = { state: 'not-linked' } | { state: 'unavailable' } | { state: 'ready'; packs: OfficePackListing[] };
/** GET /api/customer-packs/office: signed packs ready to preview, and the ones refused with a plain reason. */
export type OfficePacksView = { state: 'not-linked' } | { state: 'unavailable' } | {
  state: 'ready';
  packs: { id: string; title: string; revision: number; digest: string; pack: CustomerPack }[];
  refused: { id: string; revision: number; reason: string }[];
};

export type CustomerPackHistoryItem = NonNullable<CustomerPackInstallation['history']>[number];
export interface CustomerPackArchivePreview {
  packId: string; title: string; installedDigest: string; installedRevision: number; previewDigest: string;
  archive: CustomerPackHistoryItem[]; keep: CustomerPackHistoryItem[];
  archivedConfigurations: number; conflicts: string[]; canArchive: boolean;
}
export interface CustomerPackArchivedHistory {
  packId: string; head: string | null; cursor: string | null; nextCursor: string | null;
  history: CustomerPackHistoryItem[];
}

export type PackSkillRevisionMetadata = Omit<PackSkillRevision,'content'>;
export type PackSkillArchiveConfirmation = {
 expectedInstalledDigest: string; expectedInstalledRevision: number; expectedActiveDigest: string; expectedActiveRevision: number;
 expectedHead: string | null; expectedPreviewDigest: string;
};
export interface PackSkillHistorySummary {
 packId:string;skillId:string;name:string;installedDigest:string;installedRevision:number;activeRevision:number;activeDigest:string;
 head:string|null;hotRevisions:number;archivedRevisions:number;pendingArchive:PackSkillArchiveConfirmation|null;
}
export interface PackSkillArchivePreview {
 packId:string;skillId:string;name:string;installedDigest:string;installedRevision:number;activeRevision:number;activeDigest:string;head:string|null;previewDigest:string;
 archive:PackSkillRevisionMetadata[];keep:PackSkillRevisionMetadata[];archivedRevisions:number;conflicts:string[];canArchive:boolean;
}
export type PackSkillHistorySelection = { installationRevision:number;head:string|null;sourceDigest:string;revision:number;digest:string };
export interface PackSkillHistoryPage {
 packId:string;skillId:string;installationRevision:number;head:string|null;sourceDigest:string;cursor:string|null;nextCursor:string|null;revisions:PackSkillRevisionMetadata[];
}
export interface PackSkillRevertPreview {
 packId:string;skillId:string;name:string;selection:PackSkillHistorySelection;reviewDigest:string;
 installedDigest:string;installedRevision:number;activeRevision:number;activeDigest:string;current:string;proposed:string;
 target:PackSkillRevisionMetadata;conflicts:string[];canRevert:boolean;
}
