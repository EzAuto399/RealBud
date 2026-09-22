import { MEMORY_REVIEW_API, memoryReviewDigest } from './hermes-memory-review.ts';

export const MEMORY_RECOVERY_API = `${MEMORY_REVIEW_API}/interrupted`;
export interface MemoryRecoveryItem {
  key: string; state: 'interrupted' | 'closed' | 'recovery-required';
  createdAt: number | null; closedAt: number | null; recoveryDigest: string | null;
}
export interface MemoryRecoveryPage { version: 1; items: MemoryRecoveryItem[]; nextCursor: string | null }
export interface MemoryRecoveryClosure { version: 1; key: string; state: 'closed'; closedAt: number; recoveryDigest: string }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, names: string[]) => Object.keys(v).length === names.length && names.every(name => Object.hasOwn(v, name));
const timestamp = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 8.64e15;

export function parseMemoryRecoveryPage(value: unknown): MemoryRecoveryPage | null {
  if (!object(value) || !exact(value, ['version', 'items', 'nextCursor']) || value.version !== 1 ||
    !Array.isArray(value.items) || value.items.length > 20 || value.nextCursor !== null && !memoryReviewDigest(value.nextCursor)) return null;
  let previous = '';
  for (const row of value.items) {
    if (!object(row) || !exact(row, ['key', 'state', 'createdAt', 'closedAt', 'recoveryDigest']) ||
      !memoryReviewDigest(row.key) || row.key <= previous ||
      row.createdAt !== null && !timestamp(row.createdAt) || row.closedAt !== null && !timestamp(row.closedAt) ||
      row.recoveryDigest !== null && !memoryReviewDigest(row.recoveryDigest)) return null;
    previous = row.key;
    if (row.state === 'interrupted') {
      if (row.createdAt === null || row.closedAt !== null || row.recoveryDigest === null) return null;
    } else if (row.state === 'closed') {
      if (row.createdAt === null || row.closedAt === null || row.recoveryDigest === null) return null;
    } else if (row.state !== 'recovery-required' || row.closedAt !== null || row.recoveryDigest !== null) return null;
  }
  if (value.nextCursor !== null && value.nextCursor !== value.items.at(-1)?.key) return null;
  return structuredClone(value) as unknown as MemoryRecoveryPage;
}

export function parseMemoryRecoveryClosure(value: unknown): MemoryRecoveryClosure | null {
  if (!object(value) || !exact(value, ['version', 'key', 'state', 'closedAt', 'recoveryDigest']) ||
    value.version !== 1 || value.state !== 'closed' || !memoryReviewDigest(value.key) ||
    !memoryReviewDigest(value.recoveryDigest) || !timestamp(value.closedAt)) return null;
  return { ...value } as unknown as MemoryRecoveryClosure;
}
