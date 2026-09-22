import type { CompanyExecutionGrant, CompanyExecutionGrantPage, CompanyExecutionReview } from './company-execution.ts';

export type DepartmentWorkPrepare = { version: 1; requestId: string; departmentId: string; expectedDepartmentRevision: string; caseId: string; expectedCaseFence: string; recipeId: string; expectedRecipeRevision: number; durationMs: number };
export type DepartmentWorkCatalog = { recipes: { id: string; revision: number; title: string; review: CompanyExecutionReview }[] };
export type DepartmentWorkState = {
  grantId: string; executionId: string; caseId: string; request: DepartmentWorkPrepare;
  phase: 'requesting'|'waiting-owner'|'admitting'|'running'|'review-required'|'held';
  detail: string; runId: string | null; updatedAt: number;
  result: { status: string; detail: string; outputs: string[] } | null;
};
export type DepartmentWorkPage = CompanyExecutionGrantPage & { local: DepartmentWorkState[] };
export type DepartmentWorkPrepared = { grant: CompanyExecutionGrant; local: DepartmentWorkState };

export function isDepartmentWorkPrepare(v: unknown): v is DepartmentWorkPrepare {
  if (!v || typeof v!=='object' || Array.isArray(v)) return false;
  const b=v as Record<string,unknown>;
  const uuid=(x:unknown)=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x);
  const id=(x:unknown)=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(x);
  const decimal=(x:unknown)=>typeof x==='string'&&/^(0|[1-9][0-9]{0,18})$/.test(x)&&BigInt(x)<=BigInt('9223372036854775807');
  return Object.keys(b).sort().join(',')==='caseId,departmentId,durationMs,expectedCaseFence,expectedDepartmentRevision,expectedRecipeRevision,recipeId,requestId,version' && b.version===1 && uuid(b.requestId) && id(b.departmentId) && id(b.caseId) && decimal(b.expectedDepartmentRevision) && decimal(b.expectedCaseFence) && typeof b.recipeId==='string' && b.recipeId.length>0 && b.recipeId.length<=128 && !b.recipeId.includes('\0') && Number.isSafeInteger(b.expectedRecipeRevision) && Number(b.expectedRecipeRevision)>=1 && Number.isSafeInteger(b.durationMs) && Number(b.durationMs)>=60_000 && Number(b.durationMs)<=7*86_400_000;
}
