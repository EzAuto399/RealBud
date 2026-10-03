/** Private auto-keep setting and undo ledger for one workspace worker profile.
 * Lives in RealBud's data directory, outside the worker's own writable home,
 * so the worker cannot turn auto-keep on or forge kept rows. Kept rows hold the
 * exact text so undo can remove exactly that entry; undone rows hold only a
 * digest of the normalized text, so an undone learning is never kept again.
 * Nothing here is logged. Damaged or foreign files are preserved and hold all mutation. */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { DATA_DIR } from './config.ts';
import { readPrivateJson, writePrivateJson } from './private-json.ts';
import { memoryReviewDigest, memoryReviewId, MEMORY_LEARNING_KEPT_LIMIT, MEMORY_LEARNING_TEXT_LIMIT,
  type MemoryLearningState, type MemoryReviewTarget } from '../shared/hermes-memory-review.ts';
import { normalizeLearningText } from '../shared/learning-policy.ts';

export const LEARNING_UNDO_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Undone digests are kept beyond 30 days so an undo sticks; the oldest beyond this bound are dropped. */
export const LEARNING_UNDONE_LIMIT = 500;
export const LEARNING_STORE_BYTES = 1024 * 1024;
export interface LearningBinding { workspaceId: string; profileId: string }
export interface LearningUndo { requestId: string; state: 'proposing' | 'deciding' | 'rejecting'; proposalId: string | null; proposalDigest: string | null }
export interface LearningEntry {
  reviewId: string; reviewDigest: string; target: MemoryReviewTarget;
  /** Exact saved text while intent/kept; null once undone. */
  text: string | null; textDigest: string;
  decidedBy: 'policy'; policyVersion: 1;
  /** intent: written before the decision was dispatched and not yet confirmed. */
  state: 'intent' | 'kept' | 'undone'; at: number; keptAt: number | null; undoneAt: number | null;
  undo: LearningUndo | null; undoAttempts: number;
}
export interface LearningStore extends LearningBinding { version: 1; autoKeep: boolean; updatedAt: number | null; entries: LearningEntry[] }

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const time = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 8.64e15;
const recovery = () => Object.assign(new Error('Memory files need service review. Existing files were preserved.'), { code: 'unsafe-storage', status: 409 });
const WORKSPACE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/, PROFILE = /^property(?:-[a-z0-9-]+)?$/;

/** sha256 of the normalized learning text; the only trace an undone row keeps. */
export function learningTextDigest(text: string): string {
  return createHash('sha256').update(normalizeLearningText(text).replace(/\s+/g, ' ').trim()).digest('hex');
}
/** RealBud-owned location, keyed by workspace and worker profile. */
export function defaultLearningDirectory(binding: LearningBinding, dataDirectory = DATA_DIR): string {
  if (!WORKSPACE.test(binding.workspaceId) || !PROFILE.test(binding.profileId) || binding.profileId.length > 64) {
    throw Object.assign(new Error('This worker or proposal format needs an update before it can be reviewed.'), { code: 'unsupported', status: 409 });
  }
  return join(dataDirectory, 'memory-learning', binding.workspaceId, binding.profileId);
}

function undo(v: unknown): v is LearningUndo {
  return v === null || object(v) && exact(v, ['requestId', 'state', 'proposalId', 'proposalDigest']) && typeof v.requestId === 'string' && /^undo-[a-f0-9]{32}-\d{1,3}$/.test(v.requestId) &&
    ['proposing', 'deciding', 'rejecting'].includes(v.state as string) && (v.proposalId === null || memoryReviewId(v.proposalId)) &&
    (v.proposalDigest === null || memoryReviewDigest(v.proposalDigest)) && (v.state === 'proposing' || v.proposalId !== null && v.proposalDigest !== null);
}
function entry(v: unknown): v is LearningEntry {
  if (!object(v) || !exact(v, ['reviewId', 'reviewDigest', 'target', 'text', 'textDigest', 'decidedBy', 'policyVersion', 'state', 'at', 'keptAt', 'undoneAt', 'undo', 'undoAttempts']) ||
    !memoryReviewId(v.reviewId) || !memoryReviewDigest(v.reviewDigest) || (v.target !== 'memory' && v.target !== 'user') || !memoryReviewDigest(v.textDigest) ||
    v.decidedBy !== 'policy' || v.policyVersion !== 1 || !['intent', 'kept', 'undone'].includes(v.state as string) || !time(v.at) ||
    !Number.isSafeInteger(v.undoAttempts) || (v.undoAttempts as number) < 0 || (v.undoAttempts as number) > 999 || !undo(v.undo)) return false;
  if (v.state === 'undone') return v.text === null && time(v.undoneAt) && time(v.keptAt) && v.undo === null;
  return typeof v.text === 'string' && !!v.text && [...v.text].length <= MEMORY_LEARNING_TEXT_LIMIT && learningTextDigest(v.text) === v.textDigest &&
    v.undoneAt === null && (v.state === 'intent' ? v.keptAt === null && v.undo === null : time(v.keptAt));
}
export function parseLearningStore(v: unknown, binding: LearningBinding): LearningStore {
  if (!object(v) || !exact(v, ['version', 'workspaceId', 'profileId', 'autoKeep', 'updatedAt', 'entries']) || v.version !== 1 ||
    v.workspaceId !== binding.workspaceId || v.profileId !== binding.profileId || typeof v.autoKeep !== 'boolean' ||
    v.updatedAt !== null && !time(v.updatedAt) || !Array.isArray(v.entries) || v.entries.length > MEMORY_LEARNING_KEPT_LIMIT + LEARNING_UNDONE_LIMIT ||
    !v.entries.every(entry) || new Set(v.entries.map(row => (row as LearningEntry).reviewDigest)).size !== v.entries.length) throw recovery();
  return structuredClone(v) as unknown as LearningStore;
}

const tails = new Map<string, Promise<void>>();
export function createLearningStore(directory: string, binding: LearningBinding, now: () => number = Date.now) {
  const file = join(directory, 'auto-keep.json');
  const empty = (): LearningStore => ({ version: 1, ...binding, autoKeep: false, updatedAt: null, entries: [] });
  const prune = (store: LearningStore) => {
    const cutoff = now() - LEARNING_UNDO_RETENTION_MS;
    // Unconfirmed intents stay until reconciled; kept rows expire after 30 days;
    // undone digests stay, bounded, so an undo keeps holding the same learning.
    const undone = store.entries.filter(row => row.state === 'undone').sort((a, b) => b.undoneAt! - a.undoneAt!).slice(0, LEARNING_UNDONE_LIMIT);
    store.entries = store.entries.filter(row => row.state === 'intent' || row.state === 'kept' && row.keptAt! >= cutoff || undone.includes(row));
    return store;
  };
  async function read(): Promise<LearningStore> {
    let raw: unknown;
    try { raw = await readPrivateJson(file, LEARNING_STORE_BYTES); } catch { throw recovery(); }
    return raw === undefined ? empty() : prune(parseLearningStore(raw, binding));
  }
  /** Serialized read-modify-write; a damaged existing file is never replaced. */
  function update<T>(change: (store: LearningStore) => T): Promise<T> {
    const work = (tails.get(file) ?? Promise.resolve()).then(async () => {
      const store = await read(), result = change(store);
      await writePrivateJson(file, prune(store), { maxBytes: LEARNING_STORE_BYTES, validate: raw => { parseLearningStore(raw, binding); } });
      return result;
    });
    const tail = work.then(() => undefined, () => undefined);
    tails.set(file, tail); void tail.then(() => { if (tails.get(file) === tail) tails.delete(file); });
    return work;
  }
  return { file, read, update };
}

/** Marks a kept row undone and drops its text, keeping only the digest. */
export function markUndone(row: LearningEntry, at: number) {
  row.state = 'undone'; row.undoneAt = at; row.text = null; row.undo = null;
}

export function publicLearningState(store: LearningStore): MemoryLearningState {
  return { version: 1, autoKeep: store.autoKeep, policyVersion: 1,
    kept: store.entries.filter(row => row.state === 'kept').sort((a, b) => b.keptAt! - a.keptAt!).map(row => ({
      reviewId: row.reviewId, reviewDigest: row.reviewDigest, target: row.target, text: row.text!, keptAt: row.keptAt!,
      decidedBy: 'policy' as const, policyVersion: 1 as const, undoStarted: row.undo !== null })) };
}
