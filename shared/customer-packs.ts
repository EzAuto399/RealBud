import type { Recipe } from './contracts.ts';

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
