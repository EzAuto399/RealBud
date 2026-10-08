/** RealBud's canonical copy of every fact a worker profile holds.
 *
 * The worker profile (D/hermes/profiles/<profile>) is a projection. RealBud
 * keeps memory, pending proposals, review receipts and journals, office edits
 * to SOUL/skills and pending skill records under D/worker-state/<workspace>/<scope>/,
 * commits there first, then projects into the profile before launch or Repair.
 * Deleting or replacing the profile loses nothing that was captured here.
 *
 * Invariants: never delete or silently overwrite a worker copy; a worker copy
 * that differs from what RealBud last projected is preserved, not replaced;
 * credential-bearing bytes are never captured (only their digest is noted). */
import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR } from './config.ts';
import { readPrivateJson, writePrivateJson } from './private-json.ts';
import { ensureProfileDirectories, readProfileFiles, writeProfileFiles, type ProfileFileWrite } from './hermes-profile-storage.ts';
import { containsCredential } from './redact.ts';

export interface WorkerScope { workspaceId: string; scopeId: string; profileId: string; profileDirectory: string }
export type ArtifactSource = 'import' | 'realbud' | 'office' | 'worker';
export interface WorkerArtifact { digest: string; base64: string; source: ArtifactSource; at: number }
export interface PreservedCopy { key: string; digest: string; base64: string; reason: 'import-differs' | 'worker-changed' | 'repair-replaced'; at: number }
export interface HeldCopy { key: string; digest: string; reason: 'credential' | 'unsafe' | 'capacity'; at: number }
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
const MEMORY_BYTES = 128 * 1024, FILE_BYTES = 2 * 1024 * 1024, SKILL_FILES = 1000, SKILL_BYTES = 8 * 1024 * 1024, PRESERVED_LIMIT = 200;
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
  for (const row of v.held) if (!object(row) || !validWorkerKey(row.key) || !HEX64.test(String(row.digest)) || !time(row.at) || !['credential', 'unsafe', 'capacity'].includes(String(row.reason))) recovery();
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
/** Draft helpers: every content change goes through these so digests stay exact. */
export function putArtifact(state: WorkerState, key: string, bytes: Buffer, source: ArtifactSource, at: number): void {
  if (!validWorkerKey(key)) recovery();
  const digest = sha256(bytes);
  if (state.artifacts[key]?.digest === digest) return;
  state.artifacts[key] = { digest, base64: bytes.toString('base64'), source, at };
}
export function preserveCopy(state: WorkerState, key: string, bytes: Buffer, reason: PreservedCopy['reason'], at: number): void {
  const digest = sha256(bytes);
  // Credential-shaped bytes are never kept: only their digest is noted.
  if (!key.startsWith('.realbud-memory-reviews/') && containsCredential(bytes.toString('utf8'))) { hold(state, key, bytes, 'credential', at); return; }
  if (state.preserved.some(row => row.key === key && row.digest === digest)) return;
  // Never dropped: past the bound the save is refused and the scope needs service.
  if (state.preserved.length >= PRESERVED_LIMIT) throw Object.assign(new Error('Preserved worker copies need service review.'), { code: 'capacity', status: 409 });
  state.preserved.push({ key, digest, base64: bytes.toString('base64'), reason, at });
}
function hold(state: WorkerState, key: string, bytes: Buffer, reason: HeldCopy['reason'], at: number) {
  const digest = sha256(bytes);
  if (!state.held.some(row => row.key === key && row.digest === digest)) state.held.push({ key, digest, reason, at });
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

type WorkerRead = Map<string, Buffer | 'unsafe'>;
async function regularFile(path: string, max: number): Promise<'ok' | 'missing' | 'unsafe'> {
  try { const stat = await lstat(path); return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= max ? 'ok' : 'unsafe'; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'; return 'unsafe'; }
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
    if (state === 'unsafe') out.set(key, 'unsafe'); else if (state === 'ok') ok.push(key);
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
  const walk = async (relative: string, depth: number) => {
    for (const entry of await names(join(profile, ...relative.split('/')))) {
      const key = `${relative}/${entry.name}`;
      if (!validWorkerKey(key) || entry.link || relative === 'skills' && entry.name.startsWith('realbud-')) continue;
      if (entry.directory) { if (depth) await walk(key, depth - 1); }
      else if (keys.length < SKILL_FILES + 2000) keys.push({ key, max: FILE_BYTES });
    }
  };
  await walk('skills', 8);
  return keys;
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

/** Classify one worker copy for capture: bytes, or a held reason. */
function capturable(key: string, bytes: Buffer): HeldCopy['reason'] | null {
  if (key.startsWith('.realbud-memory-reviews/')) return null; // signed metadata, never free text
  if (containsCredential(bytes.toString('utf8'))) return 'credential';
  return null;
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
    const shipped = shippedWith(options.shipped ?? noneShipped, files.get('.realbud-shipped.json') === 'unsafe' ? null : files.get('.realbud-shipped.json') as Buffer | undefined);
    const lines = [...files].map(([key, bytes]) => `${key} ${bytes === 'unsafe' ? 'unsafe' : sha256(bytes)}`).sort();
    const sourceDigest = sha256(lines.join('\n')), at = now();
    let skillBytes = 0;
    const counts = { imported: 0, preserved: 0, held: 0 };
    await updateWorkerState(scope, null, draft => {
      for (const [key, bytes] of files) {
        if (bytes === 'unsafe') { hold(draft, key, Buffer.from(key), 'unsafe', at); counts.held++; continue; }
        const digest = sha256(bytes);
        if (officeFile(key) && shipped.has(key, digest)) continue;
        if (key.startsWith('skills/') && (skillBytes += bytes.length) > SKILL_BYTES) { hold(draft, key, bytes, 'capacity', at); counts.held++; continue; }
        const refused = capturable(key, bytes);
        if (refused) { hold(draft, key, bytes, refused, at); counts.held++; continue; }
        const current = draft.artifacts[key];
        if (!current) { putArtifact(draft, key, bytes, 'import', at); counts.imported++; }
        else if (current.digest !== digest) { preserveCopy(draft, key, bytes, 'import-differs', at); counts.preserved++; }
        if (projectableKey(key) && (!current || current.digest === digest)) draft.projected[key] = digest;
      }
      draft.migration = { sourceDigest, complete: false, at };
    }, dataDir);
    // Read back: every captured worker copy is now canonical or preserved.
    const saved = await readWorkerState(scope, dataDir);
    for (const [key, bytes] of files) {
      if (bytes === 'unsafe') continue;
      const digest = sha256(bytes);
      if (officeFile(key) && shipped.has(key, digest) || saved.held.some(row => row.key === key && row.digest === digest)) continue;
      if (saved.artifacts[key]?.digest !== digest && !saved.preserved.some(row => row.key === key && row.digest === digest)) recovery();
    }
    await updateWorkerState(scope, null, draft => { draft.migration = { sourceDigest, complete: true, at: now() }; }, dataDir);
    results.push({ scopeId: scope.scopeId, complete: true, ...counts, skipped: false });
  }
  return results;
}

export interface ProjectionResult { written: string[]; captured: string[]; preserved: string[]; skipped: 'profile-missing' | null }
/** Bring the worker profile up to RealBud's canonical copy. A missing copy is
 * regenerated; a copy RealBud wrote (or shipped) is updated; a copy changed
 * since the last projection becomes canonical when RealBud did not change it
 * meanwhile (an office edit), otherwise it is preserved and left in place. */
export async function projectProfileFacts(scope: WorkerScope, options: { dataDir?: string; now?: () => number; shipped?: ShippedDigests; keys?: readonly string[] } = {}): Promise<ProjectionResult> {
  const dataDir = options.dataDir ?? DATA_DIR, now = options.now ?? Date.now, result: ProjectionResult = { written: [], captured: [], preserved: [], skipped: null };
  const root = await lstat(scope.profileDirectory).catch(() => null);
  if (!root?.isDirectory() || root.isSymbolicLink()) return { ...result, skipped: 'profile-missing' };
  const state = await readWorkerState(scope, dataDir);
  const discovered = options.keys ? [] : (await workerFactKeys(scope.profileDirectory)).filter(row => projectableKey(row.key));
  const wanted = new Map<string, number>([...discovered.map(row => [row.key, row.max] as [string, number]),
    ...Object.keys(state.artifacts).filter(projectableKey).filter(key => !options.keys || options.keys.includes(key)).map(key => [key, key.startsWith('memories/') ? MEMORY_BYTES : FILE_BYTES] as [string, number])]);
  const files = await readWorkerFiles(scope.profileDirectory, [...wanted, ['.realbud-shipped.json', 256 * 1024] as [string, number]].map(([key, max]) => ({ key, max })));
  const shipped = shippedWith(options.shipped ?? noneShipped, artifactBytes(state, '.realbud-shipped.json'), files.get('.realbud-shipped.json') as Buffer | undefined);
  const writes: { key: string; write: ProfileFileWrite; digest: string }[] = [], at = now();
  await updateWorkerState(scope, null, draft => {
    for (const key of wanted.keys()) {
      const worker = files.get(key), canonical = draft.artifacts[key], projected = draft.projected[key];
      if (worker === 'unsafe') continue;
      const workerDigest = worker ? sha256(worker) : null;
      if (!canonical) {
        // An office file RealBud has never seen: capture it (shipped bytes are the pack's own).
        if (!worker || workerDigest === null || !officeFile(key) || shipped.has(key, workerDigest) || capturable(key, worker)) continue;
        putArtifact(draft, key, worker, 'office', at); draft.projected[key] = workerDigest; result.captured.push(key); continue;
      }
      if (workerDigest === canonical.digest) { draft.projected[key] = workerDigest; continue; }
      const replaceable = worker === undefined || workerDigest === projected || officeFile(key) && workerDigest !== null && shipped.has(key, workerDigest);
      if (replaceable) {
        writes.push({ key, digest: canonical.digest, write: { path: join(scope.profileDirectory, ...key.split('/')), bytes: Buffer.from(canonical.base64, 'base64'), ...(worker ? { expected: worker } : { overwrite: false }) } });
        continue;
      }
      // The worker copy changed since RealBud's last projection.
      if (canonical.digest === projected && worker && !capturable(key, worker)) { putArtifact(draft, key, worker, officeFile(key) ? 'office' : 'worker', at); draft.projected[key] = workerDigest!; result.captured.push(key); }
      else if (worker) { preserveCopy(draft, key, worker, 'worker-changed', at); result.preserved.push(key); }
    }
  }, dataDir);
  if (!writes.length) return result;
  const folders = [...new Set(writes.map(row => row.key.split('/').slice(0, -1)).filter(parts => parts.length).flatMap(parts => parts.map((_, i) => join(scope.profileDirectory, ...parts.slice(0, i + 1)))))];
  if (folders.length) ensureProfileDirectories(folders);
  const done: { key: string; digest: string }[] = [];
  for (const row of writes) {
    // One at a time: a concurrent worker change to one file never blocks the others.
    try { writeProfileFiles([row.write]); done.push(row); result.written.push(row.key); } catch { result.preserved.push(row.key); }
  }
  if (done.length) await updateWorkerState(scope, null, draft => { for (const row of done) if (draft.artifacts[row.key]?.digest === row.digest) draft.projected[row.key] = row.digest; }, dataDir);
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
    // A record that carries credential-shaped text is never kept (it cannot be approved either).
    if (containsCredential(bytes.toString('utf8'))) { hold(draft, key, bytes, 'credential', at); return; }
    const current = draft.artifacts[key];
    if (current && current.digest !== digest) { preserveCopy(draft, key, bytes, 'worker-changed', at); throw Object.assign(new Error('A different saved skill proposal has this identifier.'), { code: 'conflict', status: 409 }); }
    putArtifact(draft, key, bytes, 'worker', at);
  }, options.dataDir ?? DATA_DIR);
  return digest;
}
