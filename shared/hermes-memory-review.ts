/** Pending worker preferences are separate from business facts and approvals. */
export const MEMORY_REVIEW_API = '/api/hermes/memory-reviews';
export const MEMORY_REVIEW_ERRORS = {
  invalid: 'This memory review request is not supported.',
  unavailable: 'Memory review is unavailable. Check Bud setup and try again.',
  'unsafe-storage': 'Memory files need service review. Existing files were preserved.',
  unsupported: 'This worker or proposal format needs an update before it can be reviewed.',
  'stale-review': 'The proposal or saved memory changed. Refresh and review the complete change again.',
  conflict: 'The saved result differs from this review. Existing memory and recovery records were preserved.',
  busy: 'Another memory review is running. Wait for it to finish, then refresh.',
  'platform-unverified': 'Windows memory review is not yet available. Existing proposals are preserved.',
  disabled: 'This memory target is disabled in Bud settings. No change was applied.',
  capacity: 'This proposal exceeds the supported memory limit. Ask Bud to prepare a smaller change.',
  'blocked-content': 'This change contains content that cannot be shown or approved here. Existing files were preserved.',
  'recovery-required': 'This memory decision needs recovery. Refresh its saved state before retrying.',
  'proposal-closed': 'This interrupted proposal was closed. Ask Bud to prepare a new proposal if it is still needed.',
} as const;
export type MemoryReviewErrorCode = keyof typeof MEMORY_REVIEW_ERRORS;
export type MemoryReviewAction = 'add' | 'replace' | 'remove' | 'batch';
export type MemoryReviewTarget = 'memory' | 'user';
export type MemoryReviewOrigin = 'foreground' | 'background_review';
export interface MemoryReviewItem {
  id: string; state: 'pending' | 'applied' | 'rejected' | 'recovery-required' | 'unavailable';
  action: MemoryReviewAction | null; target: MemoryReviewTarget | null; origin: MemoryReviewOrigin | null; createdAt: number | null;
  decision: 'approve' | 'reject' | null; reviewDigest: string | null;
}
export interface MemoryReviewPage { version: 1; items: MemoryReviewItem[]; nextCursor: string | null; total: number; held: number }
export interface MemoryReviewPreview {
  version: 1; id: string; target: MemoryReviewTarget; action: MemoryReviewAction; origin: MemoryReviewOrigin;
  createdAt: number; reviewDigest: string; before: string; after: string; operationCount: number; charLimit: number;
}
export interface MemoryReviewDecision { version: 1; id: string; state: 'applied' | 'rejected'; reviewDigest: string; changed: boolean; at: number }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fields = (v: Record<string, unknown>, names: string[]) => Object.keys(v).length === names.length && names.every(name => Object.hasOwn(v, name));
const integer = (v: unknown, min = 0) => Number.isSafeInteger(v) && Number(v) >= min;
const timestamp = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 8.64e15;
export const memoryReviewId = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}$/.test(v);
export const memoryReviewDigest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const action = (v: unknown) => typeof v === 'string' && ['add', 'replace', 'remove', 'batch'].includes(v);
const target = (v: unknown) => v === 'memory' || v === 'user';
const origin = (v: unknown) => v === 'foreground' || v === 'background_review';
export function parseMemoryReviewPage(v: unknown): MemoryReviewPage | null {
  if (!object(v) || !fields(v, ['version', 'items', 'nextCursor', 'total', 'held']) || v.version !== 1 || !Array.isArray(v.items) || v.items.length > 20 ||
    !integer(v.total) || Number(v.total) > 2000 || !integer(v.held) || Number(v.held) > Number(v.total) || v.items.length > Number(v.total) || v.nextCursor !== null && !memoryReviewId(v.nextCursor)) return null;
  const ids = new Set<string>();
  for (const row of v.items) {
    if (!object(row) || !fields(row, ['id', 'state', 'action', 'target', 'origin', 'createdAt', 'decision', 'reviewDigest']) || !memoryReviewId(row.id) || ids.has(row.id) ||
      typeof row.state !== 'string' || !['pending', 'applied', 'rejected', 'recovery-required', 'unavailable'].includes(row.state) || row.action !== null && !action(row.action) ||
      row.target !== null && !target(row.target) || row.origin !== null && !origin(row.origin) || row.createdAt !== null && !timestamp(row.createdAt) ||
      row.decision !== null && row.decision !== 'approve' && row.decision !== 'reject' || row.reviewDigest !== null && !memoryReviewDigest(row.reviewDigest) ||
      (row.decision === null) !== (row.reviewDigest === null) ||
      row.state === 'pending' && (row.decision !== null || row.action === null || row.target === null || row.origin === null || row.createdAt === null) ||
      row.state === 'applied' && row.decision !== 'approve' || row.state === 'rejected' && row.decision !== 'reject' ||
      row.state === 'unavailable' && row.decision !== null) return null;
    ids.add(row.id);
  }
  return structuredClone(v) as unknown as MemoryReviewPage;
}
export function parseMemoryReviewPreview(v: unknown): MemoryReviewPreview | null {
  if (!object(v) || !fields(v, ['version', 'id', 'target', 'action', 'origin', 'createdAt', 'reviewDigest', 'before', 'after', 'operationCount', 'charLimit']) ||
    v.version !== 1 || !memoryReviewId(v.id) || !target(v.target) || !action(v.action) || !origin(v.origin) || !timestamp(v.createdAt) || !memoryReviewDigest(v.reviewDigest) ||
    typeof v.before !== 'string' || typeof v.after !== 'string' || new TextEncoder().encode(v.before).byteLength > 131_072 || new TextEncoder().encode(v.after).byteLength > 131_072 ||
    !integer(v.operationCount, 1) || Number(v.operationCount) > 100 || !integer(v.charLimit, 1) || Number(v.charLimit) > 100_000 ||
    [...v.after].length > Number(v.charLimit) && (v.action !== 'remove' || [...v.after].length >= [...v.before].length)) return null;
  return { ...v } as unknown as MemoryReviewPreview;
}
export function parseMemoryReviewDecision(v: unknown): MemoryReviewDecision | null {
  if (!object(v) || !fields(v, ['version', 'id', 'state', 'reviewDigest', 'changed', 'at']) || v.version !== 1 || !memoryReviewId(v.id) ||
    typeof v.state !== 'string' || !['applied', 'rejected'].includes(v.state) || !memoryReviewDigest(v.reviewDigest) || typeof v.changed !== 'boolean' ||
    v.state === 'rejected' && v.changed || !timestamp(v.at)) return null;
  return { ...v } as unknown as MemoryReviewDecision;
}
