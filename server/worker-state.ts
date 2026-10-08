/** RealBud's canonical copy of every fact a worker profile holds.
 *
 * The worker profile (D/hermes/profiles/<profile>) is a projection. RealBud
 * keeps memory, pending proposals, review receipts and journals, office edits
 * to SOUL/skills and pending skill records under D/worker-state/<workspace>/<scope>/,
 * commits there first, then projects into the profile before launch or Repair.
 * Deleting or replacing the profile loses nothing that was captured here.
 *
 * Invariants: worker-side bytes never become canonical, except once in the
 * trusted first-boot import; a worker copy that differs from what RealBud last
 * projected is preserved for a person's review (memory as a reviewable proposal);
 * credential-shaped or over-cap bytes are never stored, only a digest, size and
 * reason; every scope shares one byte and entry cap. */
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { DATA_DIR } from './config.ts';
import { readPrivateJsonWithFallback, writePrivateJson } from './private-json.ts';
import { ensureProfileDirectories, readProfileFiles, writeProfileFiles, type ProfileFileWrite } from './hermes-profile-storage.ts';
import { containsCredential } from './redact.ts';
import { workerEditRecord } from './hermes-memory-store.ts';

export interface WorkerScope { workspaceId: string; scopeId: string; profileId: string; profileDirectory: string }
export type ArtifactSource = 'import' | 'realbud' | 'office' | 'worker';
export interface WorkerArtifact { digest: string; base64: string; source: ArtifactSource; at: number }
export interface PreservedCopy { key: string; digest: string; base64: string; reason: 'import-differs' | 'worker-changed' | 'repair-replaced'; at: number }
/** Digest, size and reason only: content that was withheld from canonical storage. */
export interface HeldCopy { key: string; digest: string; bytes: number; reason: 'credential' | 'unsafe' | 'capacity'; at: number }
export interface WorkerState {
  version: 1; purpose: 'worker-facts'; workspaceId: string; scopeId: string; profileId: string; revision: number;
  artifacts: Record<string, WorkerArtifact>;
  /** Logical key → digest RealBud last wrote to (or observed in) the worker copy. */
  projected: Record<string, string>;
  preserved: PreservedCopy[]; held: HeldCopy[];
  migration: { sourceDigest: string | null; complete: boolean; at: number | null };
}

// ponytail: one private JSON per scope, rewritten whole; split content into
// content-addressed blobs if a scope ever approaches this cap.
export const WORKER_STATE_MAX_BYTES = 32 * 1024 * 1024;
const MEMORY_BYTES = 128 * 1024, FILE_BYTES = 2 * 1024 * 1024;
/** One shared cap per scope for stored content (canonical artifacts other than the two
 * memory files, plus preserved copies), and per-key size caps. Past them: a digest-only hold. */
export const WORKER_SCOPE_BYTES = 16 * 1024 * 1024, WORKER_SCOPE_ENTRIES = 3000;
const PRESERVED_LIMIT = 200, HELD_LIMIT = 1000, DISCOVERY_FILES = 64, IMPORT_FILES = 3000;
const WORKSPACE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/, PROFILE = /^property(?:-[a-z0-9-]+)?$/, SCOPE = /^[a-f0-9]{32}$/;
const KEY = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/, HEX64 = /^[a-f0-9]{64}$/;
export const MEMORY_KEYS = { memory: 'memories/MEMORY.md', user: 'memories/USER.md' } as const;

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const time = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 8.64e15;
function recovery(): never { throw Object.assign(new Error('Bud’s saved learning needs service recovery. Existing files were preserved.'), { code: 'unsafe-storage', status: 409 }); }
export function validWorkerKey(key: unknown): key is string {
  return typeof key === 'string' && key.length <= 240 && KEY.test(key) && key.split('/').every(part => part !== '.' && part !== '..');
}
/** Keys RealBud writes into the worker profile. Customer-pack skills (realbud-*)
 * are projected by the customer-pack service from D/customer-packs.json. */
export function projectableKey(key: string): boolean {
  return key === 'SOUL.md' || key === MEMORY_KEYS.memory || key === MEMORY_KEYS.user || key.startsWith('skills/') && !key.startsWith('skills/realbud-');
}

/** Scope derives only from the immutable workspace and the member-derived profile name. */
export function workerScopeId(workspaceId: string, profileId: string): string {
  if (!WORKSPACE.test(workspaceId) || !PROFILE.test(profileId) || profileId.length > 64) recovery();
  return sha256(JSON.stringify(['realbud-worker-scope-v1', workspaceId, profileId])).slice(0, 32);
}
export function workerScope(workspaceId: string, profileId: string, profileDirectory: string): WorkerScope {
  return { workspaceId, scopeId: workerScopeId(workspaceId, profileId), profileId, profileDirectory };
}
export function workerStateFile(scope: Pick<WorkerScope, 'workspaceId' | 'scopeId'>, dataDir = DATA_DIR): string {
  if (!WORKSPACE.test(scope.workspaceId) || !SCOPE.test(scope.scopeId)) recovery();
  return join(dataDir, 'worker-state', scope.workspaceId, scope.scopeId, 'state.json');
}

export function validateWorkerState(v: unknown, scope?: Pick<WorkerScope, 'workspaceId' | 'scopeId'>): WorkerState {
  if (!object(v) || v.version !== 1 || v.purpose !== 'worker-facts' || typeof v.workspaceId !== 'string' || !WORKSPACE.test(v.workspaceId) ||
    typeof v.scopeId !== 'string' || !SCOPE.test(v.scopeId) || typeof v.profileId !== 'string' || !PROFILE.test(v.profileId) ||
    scope && (v.workspaceId !== scope.workspaceId || v.scopeId !== scope.scopeId) || v.scopeId !== workerScopeId(v.workspaceId, v.profileId) ||
    !Number.isSafeInteger(v.revision) || (v.revision as number) < 0 || !object(v.artifacts) || !object(v.projected) || !Array.isArray(v.preserved) || !Array.isArray(v.held) ||
    !object(v.migration) || Object.keys(v).length !== 11) recovery();
  for (const [key, row] of Object.entries(v.artifacts)) {
    if (!validWorkerKey(key) || !object(row) || Object.keys(row).length !== 4 || typeof row.base64 !== 'string' || !HEX64.test(String(row.digest)) ||
      !['import', 'realbud', 'office', 'worker'].includes(String(row.source)) || !time(row.at) || sha256(Buffer.from(row.base64, 'base64')) !== row.digest) recovery();
  }
  for (const [key, digest] of Object.entries(v.projected)) if (!validWorkerKey(key) || !HEX64.test(String(digest))) recovery();
  for (const row of v.preserved) if (!object(row) || !validWorkerKey(row.key) || !HEX64.test(String(row.digest)) || typeof row.base64 !== 'string' || !time(row.at) ||
    !['import-differs', 'worker-changed', 'repair-replaced'].includes(String(row.reason)) || sha256(Buffer.from(row.base64, 'base64')) !== row.digest) recovery();
  for (const row of v.held) if (!object(row) || !validWorkerKey(row.key) || !HEX64.test(String(row.digest)) || !time(row.at) || !['credential', 'unsafe', 'capacity'].includes(String(row.reason)) ||
    row.bytes !== undefined && (!Number.isSafeInteger(row.bytes) || (row.bytes as number) < 0)) recovery();
  const m = v.migration;
  if (Object.keys(m).length !== 3 || typeof m.complete !== 'boolean' || m.sourceDigest !== null && !HEX64.test(String(m.sourceDigest)) || m.at !== null && !time(m.at)) recovery();
  return v as unknown as WorkerState;
}

const emptyState = (scope: WorkerScope): WorkerState => ({ version: 1, purpose: 'worker-facts', workspaceId: scope.workspaceId, scopeId: scope.scopeId,
  profileId: scope.profileId, revision: 0, artifacts: {}, projected: {}, preserved: [], held: [], migration: { sourceDigest: null, complete: false, at: null } });

export async function readWorkerState(scope: WorkerScope, dataDir = DATA_DIR): Promise<WorkerState> {
  let raw: unknown;
  // A damaged file is set aside and its last good copy restored, never cleared.
  try { raw = await readPrivateJsonWithFallback(workerStateFile(scope, dataDir), WORKER_STATE_MAX_BYTES, value => { validateWorkerState(value, scope); }); } catch { recovery(); }
  if (raw === undefined) return emptyState(scope);
  const state = validateWorkerState(raw, scope);
  if (state.profileId !== scope.profileId) recovery();
  return state;
}

export function artifactBytes(state: WorkerState, key: string): Buffer | null {
  const row = state.artifacts[key];
  return row ? Buffer.from(row.base64, 'base64') : null;
}
const memoryKey = (key: string) => key === MEMORY_KEYS.memory || key === MEMORY_KEYS.user;
const keyLimit = (key: string) => key.startsWith('memories/') || key.startsWith('pending/') || key.startsWith('.realbud-memory-reviews/') ? MEMORY_BYTES : FILE_BYTES;
const stored = (base64: string) => Math.floor(base64.length * 3 / 4);
/** Content that may be stored under `key`, or why it is withheld. The two memory
 * files are bounded per key and never crowded out by other content. */
function admission(state: WorkerState, key: string, bytes: Buffer, preserving: boolean): HeldCopy['reason'] | null {
  if (containsCredential(bytes.toString('utf8'))) return 'credential';
  if (bytes.length > keyLimit(key)) return 'capacity';
  if (!preserving && memoryKey(key)) return null;
  let total = bytes.length, entries = 1;
  for (const [name, row] of Object.entries(state.artifacts)) if (!memoryKey(name) && (preserving || name !== key)) { total += stored(row.base64); entries++; }
  for (const row of state.preserved) { total += stored(row.base64); entries++; }
  return total > WORKER_SCOPE_BYTES || entries > WORKER_SCOPE_ENTRIES || preserving && state.preserved.length >= PRESERVED_LIMIT ? 'capacity' : null;
}
/** Draft helper: store content, or record a digest-only hold and return why not. */
export function putArtifact(state: WorkerState, key: string, bytes: Buffer, source: ArtifactSource, at: number): HeldCopy['reason'] | null {
  if (!validWorkerKey(key)) recovery();
  const digest = sha256(bytes);
  if (state.artifacts[key]?.digest === digest) return null;
  const refused = admission(state, key, bytes, false);
  if (refused) { holdCopy(state, key, bytes, refused, at); return refused; }
  state.artifacts[key] = { digest, base64: bytes.toString('base64'), source, at };
  return null;
}
/** Keep a worker copy beside canonical data for a person's review; never promoted. */
export function preserveCopy(state: WorkerState, key: string, bytes: Buffer, reason: PreservedCopy['reason'], at: number): HeldCopy['reason'] | null {
  const digest = sha256(bytes);
  if (state.preserved.some(row => row.key === key && row.digest === digest)) return null;
  const refused = admission(state, key, bytes, true);
  if (refused) { holdCopy(state, key, bytes, refused, at); return refused; }
  state.preserved.push({ key, digest, base64: bytes.toString('base64'), reason, at });
  return null;
}
export function holdCopy(state: WorkerState, key: string, bytes: Buffer, reason: HeldCopy['reason'], at: number) {
  const digest = sha256(bytes);
  if (state.held.some(row => row.key === key && row.digest === digest)) return;
  state.held.push({ key, digest, bytes: bytes.length, reason, at });
  // ponytail: holds are digest notes, not facts; past the bound the oldest are dropped.
  if (state.held.length > HELD_LIMIT) state.held.splice(0, state.held.length - HELD_LIMIT);
}
const clean = new Set<string>();
/** No stored content may look like a credential, whichever build wrote it: such an
 * item becomes a digest-only hold. Checked once per digest. */
function sanitize(state: WorkerState) {
  const flagged = (digest: string, base64: string) => {
    if (clean.has(digest)) return false;
    if (containsCredential(Buffer.from(base64, 'base64').toString('utf8'))) return true;
    if (clean.size > 20_000) clean.clear();
    clean.add(digest); return false;
  };
  for (const [key, row] of Object.entries(state.artifacts)) if (flagged(row.digest, row.base64)) {
    holdCopy(state, key, Buffer.from(row.base64, 'base64'), 'credential', row.at); delete state.artifacts[key];
  }
  state.preserved = state.preserved.filter(row => {
    if (!flagged(row.digest, row.base64)) return true;
    holdCopy(state, row.key, Buffer.from(row.base64, 'base64'), 'credential', row.at); return false;
  });
}
/** Logical bytes of a saved scope for a backup: the same rule applied without writing. */
export function sanitizedWorkerStateBytes(data: Buffer): Buffer {
  let value: unknown; try { value = JSON.parse(data.toString('utf8')); } catch { return data; }
  if (!object(value) || !object(value.artifacts) || !Array.isArray(value.preserved) || !Array.isArray(value.held)) return data;
  const before = JSON.stringify(value); sanitize(value as unknown as WorkerState);
  return JSON.stringify(value) === before ? data : Buffer.from(JSON.stringify(value));
}
/** Withheld items recorded in a saved scope (digest-only holds). */
export function workerStateHeldCount(data: Buffer): number {
  try { const value = JSON.parse(data.toString('utf8')) as { held?: unknown }; return Array.isArray(value.held) ? value.held.length : 0; } catch { return 0; }
}
/** Folder-level note for names a capped listing never examined. */
function holdUnlisted(state: WorkerState, folder: string, count: number, at: number) {
  if (count <= 0) return;
  state.held = state.held.filter(row => !(row.key === folder && row.reason === 'capacity' && row.digest === sha256(`realbud-unlisted-v1\0${folder}`)));
  state.held.push({ key: folder, digest: sha256(`realbud-unlisted-v1\0${folder}`), bytes: count, reason: 'capacity', at });
  if (state.held.length > HELD_LIMIT) state.held.splice(0, state.held.length - HELD_LIMIT);
}
const strictKey = (key: string) => key.startsWith('memories/') || key.startsWith('pending/') || key.startsWith('.realbud-memory-reviews/');
/** The review helper's admission for memory and proposal files (POSIX): owned by
 * this account with no group or other access, inside folders of this account that
 * no one else can write. Windows ACLs are admitted by the profile reader. */
export function strictWorkerFile(profile: string, path: string): boolean {
  if (process.platform === 'win32') return true;
  const uid = process.getuid?.();
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== uid || (stat.mode & 0o077) !== 0) return false;
    for (let folder = dirname(path); ; folder = dirname(folder)) {
      const dir = lstatSync(folder);
      if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== uid || (dir.mode & 0o022) !== 0) return false;
      if (resolve(folder) === resolve(profile) || dirname(folder) === folder) return true;
    }
  } catch { return false; }
}
/** A worker's direct edit of MEMORY.md/USER.md never changes canonical memory: it
 * becomes a reviewable proposal (or, when not expressible as one, a preserved copy). */
export function recordWorkerMemoryEdit(state: WorkerState, target: 'memory' | 'user', bytes: Buffer, at: number): 'proposed' | 'preserved' | HeldCopy['reason'] {
  const key = MEMORY_KEYS[target];
  if (containsCredential(bytes.toString('utf8'))) { holdCopy(state, key, bytes, 'credential', at); return 'credential'; }
  let after: string;
  try { after = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { holdCopy(state, key, bytes, 'unsafe', at); return 'unsafe'; }
  const before = artifactBytes(state, key)?.toString('utf8') ?? '';
  const record = workerEditRecord(target, before, after, at);
  if (record) {
    // The same edit is staged once; a decided one is never reopened.
    if (state.artifacts[`pending/memory/${record.id}.json`] || state.artifacts[`.realbud-memory-reviews/${record.id}.json`]) return 'proposed';
    return putArtifact(state, `pending/memory/${record.id}.json`, record.bytes, 'worker', at) ?? 'proposed';
  }
  return preserveCopy(state, key, bytes, 'worker-changed', at) ?? 'preserved';
}

const tails = new Map<string, Promise<void>>();
/** Serialized read-modify-write. `expectedRevision` (when given) is compared
 * inside the lock. Writes only when the draft changed; a damaged file is never replaced. */
export function updateWorkerState<T>(scope: WorkerScope, expectedRevision: number | null, change: (draft: WorkerState) => T, dataDir = DATA_DIR): Promise<{ state: WorkerState; result: T }> {
  const file = workerStateFile(scope, dataDir);
  const work = (tails.get(file) ?? Promise.resolve()).then(async () => {
    const current = await readWorkerState(scope, dataDir);
    if (expectedRevision !== null && current.revision !== expectedRevision) throw Object.assign(new Error('Bud’s saved learning changed. Refresh and try again.'), { code: 'stale-review', status: 409 });
    const before = JSON.stringify(current), draft = structuredClone(current);
    const result = change(draft);
    sanitize(draft);
    if (JSON.stringify(draft) === before) return { state: current, result };
    draft.revision = current.revision + 1;
    validateWorkerState(draft, scope);
    await writePrivateJson(file, draft, { maxBytes: WORKER_STATE_MAX_BYTES, validate: raw => { validateWorkerState(raw, scope); }, keepPrevious: true });
    return { state: draft, result };
  });
  const tail = work.then(() => undefined, () => undefined);
  tails.set(file, tail); void tail.then(() => { if (tails.get(file) === tail) tails.delete(file); });
  return work;
}
/** The plan's name for memory changes; the same serialized, revision-checked update. */
export const updateMemory = updateWorkerState;

// ── worker profile reads ────────────────────────────────────────────────────

/** Bytes, 'unsafe' (link, alias, unreadable) or the size of a file too large to read. */
type WorkerRead = Map<string, Buffer | 'unsafe' | { oversize: number }>;
async function regularFile(path: string, max: number): Promise<'ok' | 'missing' | 'unsafe' | { oversize: number }> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return 'unsafe';
    return stat.size <= max ? 'ok' : { oversize: stat.size };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'; return 'unsafe'; }
}
/** Never read: only a size-bound marker digest and the size are noted. */
function holdOversize(state: WorkerState, key: string, size: number, at: number) {
  if (state.held.some(row => row.key === key && row.reason === 'capacity' && row.bytes === size)) return;
  state.held.push({ key, digest: sha256(`realbud-oversize-v1\0${key}\0${size}`), bytes: size, reason: 'capacity', at });
  if (state.held.length > HELD_LIMIT) state.held.splice(0, state.held.length - HELD_LIMIT);
}
async function names(path: string): Promise<{ name: string; directory: boolean; link: boolean }[]> {
  try {
    const stat = await lstat(path); if (!stat.isDirectory() || stat.isSymbolicLink()) return [];
    return (await readdir(path, { withFileTypes: true })).map(entry => ({ name: entry.name, directory: entry.isDirectory(), link: entry.isSymbolicLink() }));
  } catch { return []; }
}
/** Admitted reads of the given profile-relative keys; unsafe or unreadable files are marked, never followed. */
async function readWorkerFiles(profile: string, keys: { key: string; max: number }[]): Promise<WorkerRead> {
  const out: WorkerRead = new Map(), ok: string[] = [];
  for (const { key, max } of keys) {
    const path = join(profile, ...key.split('/')), state = await regularFile(path, max);
    if (state === 'ok' && strictKey(key) && !strictWorkerFile(profile, path)) out.set(key, 'unsafe');
    else if (state === 'ok') ok.push(key); else if (state !== 'missing') out.set(key, state);
  }
  const read = (list: string[]) => readProfileFiles(list.map(key => join(profile, ...key.split('/'))));
  try { read(ok).forEach((bytes, index) => { if (bytes) out.set(ok[index], bytes); }); }
  catch { for (const key of ok) { try { const [bytes] = read([key]); if (bytes) out.set(key, bytes); } catch { out.set(key, 'unsafe'); } } }
  return out;
}
/** Profile-relative keys of the facts RealBud imports. */
async function workerFactKeys(profile: string): Promise<{ keys: { key: string; max: number }[]; unlisted: Map<string, number> }> {
  const keys: { key: string; max: number }[] = [{ key: 'SOUL.md', max: FILE_BYTES }, { key: MEMORY_KEYS.memory, max: MEMORY_BYTES },
    { key: MEMORY_KEYS.user, max: MEMORY_BYTES }, { key: '.realbud-shipped.json', max: 256 * 1024 }];
  const unlisted = new Map<string, number>();
  // Decision history first: worker-staged bulk can never push it past the listing cap.
  for (const [folder, pattern, max] of [['.realbud-memory-reviews', /^[a-f0-9]{8}\.json$/, MEMORY_BYTES], ['.realbud-memory-reviews/proposals', /^[a-f0-9]{64}\.(?:json|stage)$/, MEMORY_BYTES],
    ['.realbud-memory-reviews/claims', /^[a-f0-9]{8}\.json$/, MEMORY_BYTES], ['pending/memory', /^[a-f0-9]{8}\.json$/, MEMORY_BYTES], ['pending/skills', /^[a-f0-9]{8}\.json$/, 100_000]] as const) {
    const found = (await names(join(profile, ...folder.split('/')))).filter(entry => pattern.test(entry.name)).sort((a, b) => a.name < b.name ? -1 : 1);
    const room = Math.max(0, IMPORT_FILES - keys.length);
    for (const entry of found.slice(0, room)) keys.push({ key: `${folder}/${entry.name}`, max });
    if (found.length > room) unlisted.set(folder, found.length - room);
  }
  const room = Math.max(0, IMPORT_FILES - keys.length), skills = await skillKeys(profile, room + 1);
  keys.push(...skills.slice(0, room));
  if (skills.length > room) unlisted.set('skills', 1);
  return { keys, unlisted };
}
/** At most `limit` skill files, shallow first; the rest are not read at all. */
async function skillKeys(profile: string, limit: number): Promise<{ key: string; max: number }[]> {
  const out: { key: string; max: number }[] = [];
  const walk = async (relative: string, depth: number) => {
    for (const entry of await names(join(profile, ...relative.split('/')))) {
      if (out.length >= limit) return;
      const key = `${relative}/${entry.name}`;
      if (!validWorkerKey(key) || entry.link || relative === 'skills' && entry.name.startsWith('realbud-')) continue;
      if (entry.directory) { if (depth) await walk(key, depth - 1); }
      else out.push({ key, max: FILE_BYTES });
    }
  };
  await walk('skills', 4);
  return out;
}

export interface ShippedDigests { has(key: string, digest: string): boolean }
const noneShipped: ShippedDigests = { has: () => false };
/** SOUL and skill bytes are captured only when they are office edits, never bytes RealBud shipped. */
function officeFile(key: string) { return key === 'SOUL.md' || key.startsWith('skills/'); }
function shippedFromRecord(bytes: Buffer | null | undefined): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  try {
    const parsed = JSON.parse(bytes?.toString('utf8') ?? '') as { files?: Record<string, unknown> };
    for (const [key, list] of Object.entries(parsed.files ?? {})) if (Array.isArray(list)) out.set(key, new Set(list.filter(d => typeof d === 'string' && HEX64.test(d))));
  } catch { /* no record: fewer files count as shipped */ }
  return out;
}
function shippedWith(base: ShippedDigests, ...records: Array<Buffer | null | undefined>): ShippedDigests {
  const maps = records.map(shippedFromRecord);
  return { has: (key, digest) => base.has(key, digest) || maps.some(map => map.get(key)?.has(digest) === true) };
}

export interface ImportResult { scopeId: string; complete: boolean; imported: number; preserved: number; held: number; skipped: boolean }
/** First updated boot: copy every fact from the legacy worker profile into the
 * canonical store before anything mutates that profile. Idempotent; never
 * deletes the worker copy; a different canonical value is kept and the worker
 * bytes are preserved beside it. Completion is marked only after read-back. */
export const LEGACY_CONTEXTS_KEY = '.realbud-memory-reviews/legacy-contexts.json';
/** Helper-era review contexts (their JSON identity) a 0.1.42 conversation's proposals
 * were bound to, saved so a later retry finds them after the runtime is gone. */
export function legacyProposalContexts(state: WorkerState): string[] {
  try { const value = JSON.parse(artifactBytes(state, LEGACY_CONTEXTS_KEY)?.toString('utf8') ?? '[]'); return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').slice(0, 4) : []; } catch { return []; }
}
export async function recordLegacyProposalContext(scope: WorkerScope, identity: string, dataDir = DATA_DIR): Promise<void> {
  if (typeof identity !== 'string' || !identity || identity.length > 4096) return;
  await updateWorkerState(scope, null, draft => {
    const saved = legacyProposalContexts(draft);
    if (saved.includes(identity) || saved.length >= 4) return;
    putArtifact(draft, LEGACY_CONTEXTS_KEY, Buffer.from(JSON.stringify([...saved, identity])), 'realbud', Date.now());
  }, dataDir);
}
export async function importLegacyProfileFacts(scopes: WorkerScope[], options: { dataDir?: string; now?: () => number; shipped?: ShippedDigests;
  /** The helper-era review context identity per scope, saved as the legacy proposal alias. */
  legacyProposalContext?: (scope: WorkerScope) => string | null;
  /** Called per scope once its facts are imported (e.g. to save its memory-signing key). */
  afterImport?: (scope: WorkerScope) => Promise<void> } = {}): Promise<ImportResult[]> {
  const dataDir = options.dataDir ?? DATA_DIR, now = options.now ?? Date.now, results: ImportResult[] = [];
  for (const scope of scopes) {
    const existing = await readWorkerState(scope, dataDir);
    const legacy = (() => { try { return options.legacyProposalContext?.(scope) ?? null; } catch { return null; } })();
    if (legacy) await recordLegacyProposalContext(scope, legacy, dataDir);
    if (existing.migration.complete) { await options.afterImport?.(scope); results.push({ scopeId: scope.scopeId, complete: true, imported: 0, preserved: 0, held: 0, skipped: true }); continue; }
    const listing = await workerFactKeys(scope.profileDirectory), files = await readWorkerFiles(scope.profileDirectory, listing.keys);
    const record = files.get('.realbud-shipped.json'), shipped = shippedWith(options.shipped ?? noneShipped, Buffer.isBuffer(record) ? record : null);
    const lines = [...files].map(([key, bytes]) => `${key} ${Buffer.isBuffer(bytes) ? sha256(bytes) : bytes === 'unsafe' ? 'unsafe' : `oversize:${bytes.oversize}`}`).sort();
    const sourceDigest = sha256(lines.join('\n')), at = now();
    const counts = { imported: 0, preserved: 0, held: 0 }, stored = new Map<string, string>();
    // Decisions and memory first, so worker-supplied bulk can never crowd them out of the shared cap.
    const rank = (key: string) => key.startsWith('.realbud-memory-reviews/') ? 0 : memoryKey(key) ? 1 : key.startsWith('pending/') ? 2 : 3;
    await updateWorkerState(scope, null, draft => {
      for (const [key, bytes] of [...files].sort(([a], [b]) => rank(a) - rank(b) || (a < b ? -1 : 1))) {
        if (bytes === 'unsafe') { holdCopy(draft, key, Buffer.from(key), 'unsafe', at); counts.held++; continue; }
        if (!Buffer.isBuffer(bytes)) { holdOversize(draft, key, bytes.oversize, at); counts.held++; continue; }
        const digest = sha256(bytes);
        if (officeFile(key) && shipped.has(key, digest)) continue;
        const current = draft.artifacts[key];
        const refused = !current ? putArtifact(draft, key, bytes, 'import', at) : current.digest !== digest ? preserveCopy(draft, key, bytes, 'import-differs', at) : null;
        if (refused) { counts.held++; continue; }
        stored.set(key, digest);
        if (!current) counts.imported++; else if (current.digest !== digest) counts.preserved++;
        if (projectableKey(key) && (!current || current.digest === digest)) draft.projected[key] = digest;
      }
      for (const [folder, count] of listing.unlisted) { holdUnlisted(draft, folder, count, at); counts.held += count; }
      draft.migration = { sourceDigest, complete: false, at };
    }, dataDir);
    // Read back: what was stored is still stored. (Holds are notes and may be bounded away.)
    const saved = await readWorkerState(scope, dataDir);
    for (const [key, digest] of stored) if (saved.artifacts[key]?.digest !== digest && !saved.preserved.some(row => row.key === key && row.digest === digest)) recovery();
    await updateWorkerState(scope, null, draft => { draft.migration = { sourceDigest, complete: true, at: now() }; }, dataDir);
    await options.afterImport?.(scope);
    results.push({ scopeId: scope.scopeId, complete: true, ...counts, skipped: false });
  }
  return results;
}

/** `blocking`: memory files the worker can read that are not RealBud-approved bytes. */
export interface ProjectionResult { written: string[]; held: string[]; blocking: string[]; skipped: 'profile-missing' | 'migration-incomplete' | null; discoveryCapped: boolean }
/** Bring the worker profile up to RealBud's canonical copy (before every turn,
 * launch and Repair). A missing copy is regenerated; a copy RealBud wrote, or
 * bytes the pack shipped, are replaced. Worker-side bytes are never promoted:
 * a changed or unknown file is preserved for a person's review and named in
 * `held`. A changed memory file becomes a reviewable proposal and the worker
 * copy returns to the approved memory; skill and SOUL changes stay in place,
 * held. Reads only known keys plus a capped discovery list. */
export async function projectProfileFacts(scope: WorkerScope, options: { dataDir?: string; now?: () => number; shipped?: ShippedDigests; keys?: readonly string[] } = {}): Promise<ProjectionResult> {
  const dataDir = options.dataDir ?? DATA_DIR, now = options.now ?? Date.now, result: ProjectionResult = { written: [], held: [], blocking: [], skipped: null, discoveryCapped: false };
  const root = await lstat(scope.profileDirectory).catch(() => null);
  if (!root?.isDirectory() || root.isSymbolicLink()) return { ...result, skipped: 'profile-missing' };
  const state = await readWorkerState(scope, dataDir);
  // Facts not yet imported stay untouched: projection never runs ahead of the trusted import.
  if (!state.migration.complete) return { ...result, skipped: 'migration-incomplete' };
  const limit = (key: string) => memoryKey(key) ? MEMORY_BYTES : FILE_BYTES;
  const known = [...new Set([MEMORY_KEYS.memory, MEMORY_KEYS.user, 'SOUL.md', ...Object.keys(state.artifacts).filter(projectableKey)])].filter(key => !options.keys || options.keys.includes(key));
  const listed = options.keys ? [] : await skillKeys(scope.profileDirectory, DISCOVERY_FILES + 1);
  result.discoveryCapped = listed.length > DISCOVERY_FILES;
  const discovered = listed.slice(0, DISCOVERY_FILES).filter(row => !known.includes(row.key));
  const wanted = [...known.map(key => ({ key, max: limit(key) })), ...discovered];
  const files = await readWorkerFiles(scope.profileDirectory, [...wanted, { key: '.realbud-shipped.json', max: 256 * 1024 }]);
  const record = files.get('.realbud-shipped.json'), shipped = shippedWith(options.shipped ?? noneShipped, artifactBytes(state, '.realbud-shipped.json'), Buffer.isBuffer(record) ? record : null);
  const writes: { key: string; write: ProfileFileWrite; digest: string }[] = [], at = now();
  await updateWorkerState(scope, null, draft => {
    if (result.discoveryCapped) holdUnlisted(draft, 'skills', 1, at);
    for (const { key } of wanted) {
      const read = files.get(key), canonical = draft.artifacts[key], projected = draft.projected[key];
      if (read === 'unsafe') { holdCopy(draft, key, Buffer.from(key), 'unsafe', at); result.held.push(key); if (memoryKey(key)) result.blocking.push(key); continue; }
      if (read && !Buffer.isBuffer(read)) { holdOversize(draft, key, read.oversize, at); result.held.push(key); if (memoryKey(key)) result.blocking.push(key); continue; }
      const worker = read;
      if (!worker && !canonical) continue;
      const workerDigest = worker ? sha256(worker) : null;
      if (canonical && workerDigest === canonical.digest) { draft.projected[key] = canonical.digest; continue; }
      const replaceable = canonical && (worker === undefined || workerDigest === projected || officeFile(key) && shipped.has(key, workerDigest!));
      if (!replaceable && worker) {
        if (!memoryKey(key)) {
          // A skill or SOUL change made outside RealBud: kept for review, left in place, never canonical.
          if (officeFile(key) && shipped.has(key, workerDigest!)) continue;
          preserveCopy(draft, key, worker, 'worker-changed', at); result.held.push(key); continue;
        }
        const kept = recordWorkerMemoryEdit(draft, key === MEMORY_KEYS.user ? 'user' : 'memory', worker, at); result.held.push(key);
        // The worker's only copy is replaced only once it is a proposal or a preserved copy
        // (credential-shaped text is never kept and never stays readable). Otherwise it stays, held.
        if (kept === 'capacity' || kept === 'unsafe') { result.blocking.push(key); continue; }
      }
      // Memory always returns to the approved copy (empty when nothing was ever approved).
      const bytes = canonical ? Buffer.from(canonical.base64, 'base64') : Buffer.alloc(0);
      writes.push({ key, digest: sha256(bytes), write: { path: join(scope.profileDirectory, ...key.split('/')), bytes, ...(worker ? { expected: worker } : { overwrite: false }) } });
    }
  }, dataDir);
  if (!writes.length) return result;
  const done: { key: string; digest: string }[] = [], failed: string[] = [];
  for (const row of writes) {
    // One at a time: an unusable folder or a concurrent worker change holds only that file.
    const parts = row.key.split('/').slice(0, -1), folders = parts.map((_, i) => join(scope.profileDirectory, ...parts.slice(0, i + 1)));
    try { if (folders.length) ensureProfileDirectories(folders); writeProfileFiles([row.write]); done.push(row); result.written.push(row.key); }
    catch { failed.push(row.key); result.held.push(row.key); }
  }
  if (failed.length) await updateWorkerState(scope, null, draft => { for (const key of failed) holdCopy(draft, key, Buffer.from(`realbud-unwritable-v1\0${key}`), 'unsafe', now()); }, dataDir);
  if (done.length) await updateWorkerState(scope, null, draft => {
    for (const row of done) if ((draft.artifacts[row.key]?.digest ?? sha256(Buffer.alloc(0))) === row.digest) draft.projected[row.key] = row.digest;
  }, dataDir);
  return result;
}

/** Explicit Repair replaces these files with the shipped pack: the office copy
 * moves to preserved history so later projections do not restore it. */
export async function retireRepairedArtifacts(scope: WorkerScope, keys: readonly string[], options: { dataDir?: string; now?: () => number } = {}): Promise<{ retired: string[]; kept: string[] }> {
  const at = (options.now ?? Date.now)();
  const { result } = await updateWorkerState(scope, null, draft => {
    const retired: string[] = [], kept: string[] = [];
    for (const key of keys) {
      const row = draft.artifacts[key]; if (!row || !officeFile(key)) continue;
      // Deleted only once durably preserved: past the cap the office copy stays canonical (held).
      if (preserveCopy(draft, key, Buffer.from(row.base64, 'base64'), 'repair-replaced', at)) { kept.push(key); continue; }
      delete draft.artifacts[key]; delete draft.projected[key]; retired.push(key);
    }
    return { retired, kept };
  }, options.dataDir ?? DATA_DIR);
  return result;
}

export const MEMORY_HELD_MESSAGE = 'Bud’s memory file was changed outside RealBud and needs a review before Bud can work. Existing files were kept.';
/** Memory files the worker would read that are not RealBud-approved bytes (unsafe,
 * oversize or an unreviewed edit RealBud could not keep). Call after projection,
 * before a turn: a non-empty list means the turn must not start. */
export async function memoryHeldForLaunch(scope: WorkerScope, dataDir = DATA_DIR): Promise<string[]> {
  // No profile yet: nothing for the worker to read. Anything else that is not a
  // real folder (a link elsewhere, a file) is held: the worker would follow it.
  const root = await lstat(scope.profileDirectory).catch(() => null);
  if (!root) return [];
  if (!root.isDirectory() || root.isSymbolicLink()) return ['profile'];
  const state = await readWorkerState(scope, dataDir), held: string[] = [];
  const files = await readWorkerFiles(scope.profileDirectory, [MEMORY_KEYS.memory, MEMORY_KEYS.user].map(key => ({ key, max: MEMORY_BYTES })));
  for (const key of [MEMORY_KEYS.memory, MEMORY_KEYS.user]) {
    const read = files.get(key);
    if (read === undefined) continue;
    if (!Buffer.isBuffer(read)) { held.push(key); continue; }
    if (sha256(read) !== (state.artifacts[key]?.digest ?? sha256(Buffer.alloc(0)))) held.push(key);
  }
  return held;
}

/** A pending skill record RealBud captured (`pending/skills/<id>.json`). */
export async function readPendingSkill(scope: WorkerScope, id: string, dataDir = DATA_DIR): Promise<{ bytes: Buffer; digest: string } | null> {
  if (!/^[a-f0-9]{8}$/.test(id)) return null;
  const bytes = artifactBytes(await readWorkerState(scope, dataDir), `pending/skills/${id}.json`);
  return bytes ? { bytes, digest: sha256(bytes) } : null;
}
/** Release a decided record's working copy once its decision receipt is durable. */
export async function forgetPendingSkill(scope: WorkerScope, id: string, digest: string, dataDir = DATA_DIR): Promise<void> {
  if (!/^[a-f0-9]{8}$/.test(id)) return;
  await updateWorkerState(scope, null, draft => { const key = `pending/skills/${id}.json`; if (draft.artifacts[key]?.digest === digest) delete draft.artifacts[key]; }, dataDir);
}
export async function listPendingSkills(scope: WorkerScope, dataDir = DATA_DIR): Promise<string[]> {
  return Object.keys((await readWorkerState(scope, dataDir)).artifacts).flatMap(key => { const m = /^pending\/skills\/([a-f0-9]{8})\.json$/.exec(key); return m ? [m[1]] : []; }).sort();
}
/** Commit a reviewed pending skill record before acting on it. A different
 * saved record for the same id is never replaced. */
export async function capturePendingSkill(scope: WorkerScope, id: string, bytes: Buffer, options: { dataDir?: string; now?: () => number } = {}): Promise<string> {
  if (!/^[a-f0-9]{8}$/.test(id)) recovery();
  const key = `pending/skills/${id}.json`, digest = sha256(bytes), at = (options.now ?? Date.now)();
  const { result: refused } = await updateWorkerState(scope, null, draft => {
    const current = draft.artifacts[key];
    if (current && current.digest !== digest) throw Object.assign(new Error('A different saved skill proposal has this identifier.'), { code: 'conflict', status: 409 });
    return putArtifact(draft, key, bytes, 'worker', at);
  }, options.dataDir ?? DATA_DIR);
  // Recorded as a digest-only hold; the caller must not act on a record RealBud could not keep.
  if (refused) throw Object.assign(new Error(refused === 'credential' ? 'This pending proposal contains credential-shaped text and cannot be reviewed here.' : 'This pending proposal could not be saved. Review older proposals first.'), { code: refused, status: 409 });
  return digest;
}
