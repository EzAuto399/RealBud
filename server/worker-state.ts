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
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR } from './config.ts';
import { readPrivateJson, writePrivateJson } from './private-json.ts';
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
  try { raw = await readPrivateJson(workerStateFile(scope, dataDir), WORKER_STATE_MAX_BYTES); } catch { recovery(); }
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
    if (JSON.stringify(draft) === before) return { state: current, result };
    draft.revision = current.revision + 1;
    validateWorkerState(draft, scope);
    await writePrivateJson(file, draft, { maxBytes: WORKER_STATE_MAX_BYTES, validate: raw => { validateWorkerState(raw, scope); } });
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
    const state = await regularFile(join(profile, ...key.split('/')), max);
    if (state === 'ok') ok.push(key); else if (state !== 'missing') out.set(key, state);
  }
  const read = (list: string[]) => readProfileFiles(list.map(key => join(profile, ...key.split('/'))));
  try { read(ok).forEach((bytes, index) => { if (bytes) out.set(ok[index], bytes); }); }
  catch { for (const key of ok) { try { const [bytes] = read([key]); if (bytes) out.set(key, bytes); } catch { out.set(key, 'unsafe'); } } }
  return out;
}
/** Profile-relative keys of the facts RealBud imports. */
async function workerFactKeys(profile: string): Promise<{ key: string; max: number }[]> {
  const keys: { key: string; max: number }[] = [{ key: 'SOUL.md', max: FILE_BYTES }, { key: MEMORY_KEYS.memory, max: MEMORY_BYTES },
    { key: MEMORY_KEYS.user, max: MEMORY_BYTES }, { key: '.realbud-shipped.json', max: 256 * 1024 }];
  for (const [folder, pattern, max] of [['pending/memory', /^[a-f0-9]{8}\.json$/, MEMORY_BYTES], ['pending/skills', /^[a-f0-9]{8}\.json$/, 100_000],
    ['.realbud-memory-reviews', /^[a-f0-9]{8}\.json$/, MEMORY_BYTES], ['.realbud-memory-reviews/proposals', /^[a-f0-9]{64}\.(?:json|stage)$/, MEMORY_BYTES],
    ['.realbud-memory-reviews/claims', /^[a-f0-9]{8}\.json$/, MEMORY_BYTES]] as const) {
    for (const entry of await names(join(profile, ...folder.split('/')))) if (pattern.test(entry.name)) keys.push({ key: `${folder}/${entry.name}`, max });
  }
  keys.push(...await skillKeys(profile, IMPORT_FILES - Math.min(keys.length, IMPORT_FILES)));
  return keys.slice(0, IMPORT_FILES);
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
export async function importLegacyProfileFacts(scopes: WorkerScope[], options: { dataDir?: string; now?: () => number; shipped?: ShippedDigests } = {}): Promise<ImportResult[]> {
  const dataDir = options.dataDir ?? DATA_DIR, now = options.now ?? Date.now, results: ImportResult[] = [];
  for (const scope of scopes) {
    const existing = await readWorkerState(scope, dataDir);
    if (existing.migration.complete) { results.push({ scopeId: scope.scopeId, complete: true, imported: 0, preserved: 0, held: 0, skipped: true }); continue; }
    const files = await readWorkerFiles(scope.profileDirectory, await workerFactKeys(scope.profileDirectory));
    const record = files.get('.realbud-shipped.json'), shipped = shippedWith(options.shipped ?? noneShipped, Buffer.isBuffer(record) ? record : null);
    const lines = [...files].map(([key, bytes]) => `${key} ${Buffer.isBuffer(bytes) ? sha256(bytes) : bytes === 'unsafe' ? 'unsafe' : `oversize:${bytes.oversize}`}`).sort();
    const sourceDigest = sha256(lines.join('\n')), at = now();
    const counts = { imported: 0, preserved: 0, held: 0 };
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
        if (!current) counts.imported++; else if (current.digest !== digest) counts.preserved++;
        if (projectableKey(key) && (!current || current.digest === digest)) draft.projected[key] = digest;
      }
      draft.migration = { sourceDigest, complete: false, at };
    }, dataDir);
    // Read back: every captured worker copy is now canonical or preserved.
    const saved = await readWorkerState(scope, dataDir);
    for (const [key, bytes] of files) {
      if (!Buffer.isBuffer(bytes)) continue;
      const digest = sha256(bytes);
      if (officeFile(key) && shipped.has(key, digest) || saved.held.some(row => row.key === key && row.digest === digest)) continue;
      if (saved.artifacts[key]?.digest !== digest && !saved.preserved.some(row => row.key === key && row.digest === digest)) recovery();
    }
    await updateWorkerState(scope, null, draft => { draft.migration = { sourceDigest, complete: true, at: now() }; }, dataDir);
    results.push({ scopeId: scope.scopeId, complete: true, ...counts, skipped: false });
  }
  return results;
}

export interface ProjectionResult { written: string[]; held: string[]; skipped: 'profile-missing' | 'migration-incomplete' | null }
/** Bring the worker profile up to RealBud's canonical copy (before every turn,
 * launch and Repair). A missing copy is regenerated; a copy RealBud wrote, or
 * bytes the pack shipped, are replaced. Worker-side bytes are never promoted:
 * a changed or unknown file is preserved for a person's review and named in
 * `held`. A changed memory file becomes a reviewable proposal and the worker
 * copy returns to the approved memory; skill and SOUL changes stay in place,
 * held. Reads only known keys plus a capped discovery list. */
export async function projectProfileFacts(scope: WorkerScope, options: { dataDir?: string; now?: () => number; shipped?: ShippedDigests; keys?: readonly string[] } = {}): Promise<ProjectionResult> {
  const dataDir = options.dataDir ?? DATA_DIR, now = options.now ?? Date.now, result: ProjectionResult = { written: [], held: [], skipped: null };
  const root = await lstat(scope.profileDirectory).catch(() => null);
  if (!root?.isDirectory() || root.isSymbolicLink()) return { ...result, skipped: 'profile-missing' };
  const state = await readWorkerState(scope, dataDir);
  // Facts not yet imported stay untouched: projection never runs ahead of the trusted import.
  if (!state.migration.complete) return { ...result, skipped: 'migration-incomplete' };
  const limit = (key: string) => memoryKey(key) ? MEMORY_BYTES : FILE_BYTES;
  const known = [...new Set([MEMORY_KEYS.memory, MEMORY_KEYS.user, 'SOUL.md', ...Object.keys(state.artifacts).filter(projectableKey)])].filter(key => !options.keys || options.keys.includes(key));
  const discovered = options.keys ? [] : (await skillKeys(scope.profileDirectory, DISCOVERY_FILES)).filter(row => !known.includes(row.key));
  const wanted = [...known.map(key => ({ key, max: limit(key) })), ...discovered];
  const files = await readWorkerFiles(scope.profileDirectory, [...wanted, { key: '.realbud-shipped.json', max: 256 * 1024 }]);
  const record = files.get('.realbud-shipped.json'), shipped = shippedWith(options.shipped ?? noneShipped, artifactBytes(state, '.realbud-shipped.json'), Buffer.isBuffer(record) ? record : null);
  const writes: { key: string; write: ProfileFileWrite; digest: string }[] = [], at = now();
  await updateWorkerState(scope, null, draft => {
    for (const { key } of wanted) {
      const read = files.get(key), canonical = draft.artifacts[key], projected = draft.projected[key];
      if (read === 'unsafe') { holdCopy(draft, key, Buffer.from(key), 'unsafe', at); result.held.push(key); continue; }
      if (read && !Buffer.isBuffer(read)) { holdOversize(draft, key, read.oversize, at); result.held.push(key); continue; }
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
        recordWorkerMemoryEdit(draft, key === MEMORY_KEYS.user ? 'user' : 'memory', worker, at); result.held.push(key);
      }
      // Memory always returns to the approved copy (empty when nothing was ever approved).
      const bytes = canonical ? Buffer.from(canonical.base64, 'base64') : Buffer.alloc(0);
      writes.push({ key, digest: sha256(bytes), write: { path: join(scope.profileDirectory, ...key.split('/')), bytes, ...(worker ? { expected: worker } : { overwrite: false }) } });
    }
  }, dataDir);
  if (!writes.length) return result;
  const folders = [...new Set(writes.map(row => row.key.split('/').slice(0, -1)).filter(parts => parts.length).flatMap(parts => parts.map((_, i) => join(scope.profileDirectory, ...parts.slice(0, i + 1)))))];
  if (folders.length) ensureProfileDirectories(folders);
  const done: { key: string; digest: string }[] = [];
  for (const row of writes) {
    // One at a time: a concurrent worker change to one file never blocks the others.
    try { writeProfileFiles([row.write]); done.push(row); result.written.push(row.key); } catch { result.held.push(row.key); }
  }
  if (done.length) await updateWorkerState(scope, null, draft => {
    for (const row of done) if ((draft.artifacts[row.key]?.digest ?? sha256(Buffer.alloc(0))) === row.digest) draft.projected[row.key] = row.digest;
  }, dataDir);
  return result;
}

/** Explicit Repair replaces these files with the shipped pack: the office copy
 * moves to preserved history so later projections do not restore it. */
export async function retireRepairedArtifacts(scope: WorkerScope, keys: readonly string[], options: { dataDir?: string; now?: () => number } = {}): Promise<void> {
  const at = (options.now ?? Date.now)();
  await updateWorkerState(scope, null, draft => {
    for (const key of keys) {
      const row = draft.artifacts[key]; if (!row || !officeFile(key)) continue;
      preserveCopy(draft, key, Buffer.from(row.base64, 'base64'), 'repair-replaced', at);
      delete draft.artifacts[key]; delete draft.projected[key];
    }
  }, options.dataDir ?? DATA_DIR);
}

/** A pending skill record RealBud captured (`pending/skills/<id>.json`). */
export async function readPendingSkill(scope: WorkerScope, id: string, dataDir = DATA_DIR): Promise<{ bytes: Buffer; digest: string } | null> {
  if (!/^[a-f0-9]{8}$/.test(id)) return null;
  const bytes = artifactBytes(await readWorkerState(scope, dataDir), `pending/skills/${id}.json`);
  return bytes ? { bytes, digest: sha256(bytes) } : null;
}
export async function listPendingSkills(scope: WorkerScope, dataDir = DATA_DIR): Promise<string[]> {
  return Object.keys((await readWorkerState(scope, dataDir)).artifacts).flatMap(key => { const m = /^pending\/skills\/([a-f0-9]{8})\.json$/.exec(key); return m ? [m[1]] : []; }).sort();
}
/** Commit a reviewed pending skill record before acting on it. A different
 * saved record for the same id is never replaced. */
export async function capturePendingSkill(scope: WorkerScope, id: string, bytes: Buffer, options: { dataDir?: string; now?: () => number } = {}): Promise<string> {
  if (!/^[a-f0-9]{8}$/.test(id)) recovery();
  const key = `pending/skills/${id}.json`, digest = sha256(bytes), at = (options.now ?? Date.now)();
  await updateWorkerState(scope, null, draft => {
    const current = draft.artifacts[key];
    if (current && current.digest !== digest) throw Object.assign(new Error('A different saved skill proposal has this identifier.'), { code: 'conflict', status: 409 });
    // Credential-shaped or over-cap records are withheld (digest only) and so cannot be approved.
    putArtifact(draft, key, bytes, 'worker', at);
  }, options.dataDir ?? DATA_DIR);
  return digest;
}
