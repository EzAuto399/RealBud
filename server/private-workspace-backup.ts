import { WEBSITE_REMOTE_WORK_KIND, restoreWebsiteRemoteWork, validateSavedWebsiteRemoteWork } from './website-remote-work.ts';
import { DEPARTMENT_WORK_KIND, restoreDepartmentWork, validateSavedDepartmentWork } from './department-work.ts';
import { validateDepartmentWorkGraph } from './department-work-backup.ts';
import { createHash, randomBytes, randomUUID, scrypt } from 'node:crypto';
import { lstat, readdir, readFile, mkdir, open, rename, unlink, rm, chmod } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { encryptJson, decryptJson, isEncryptedEnvelope, type EncryptedEnvelope } from './desk-crypto.ts';
import { WORKFLOW_MAX_ENCRYPTED_RECORD_LENGTH } from './workflow-database.ts';
import { fsyncDir } from './atomic.ts';
import { windowsFilePrivacy } from './windows-file-privacy.ts';
import { decodeDeskPlain } from './desk-v3-decode.ts';
import { validateAgencySettings } from './agency-setup.ts';
import { validateRecipe } from './recipes.ts';
import { restoreWorkBatches, validStoredWorkBatches } from './batch-persistence.ts';
import { PRIVATE_BACKUP_COMPLETION_FILE } from './private-backup-completion.ts';
import { validateCustomerPack, validateCustomerPackUpgradeJournal, isPackArchivePath, validateCustomerPackHistoryArchive, validateCustomerPackArchiveSet } from './customer-packs.ts';
import { parseWorkspaceTabs } from '../shared/workspace-tabs.ts';
import { JOB_CAPABILITIES } from '../shared/contracts.ts';
import { SOURCE_BILL_RECORD_KINDS, validateSourceBillRecord, validateSourceBillRecords } from './source-bill-graph.ts';
import { BILL_STATUSES } from './expected-bills.ts';
import { validateSavedBankBatch, validateBankReviewLinks } from './bank-reference-validation.ts';
import { validateSavedBillProposal } from './bill-proposal-validation.ts';
import { validateSavedBillReviewDraft, validateBillReviewDraftProposalLink } from './bill-review-drafts.ts';
import { validateBackupMail } from './private-backup-mail-validation.ts';
import { MAIL_RECORD_KINDS, interruptMailRecordsForRestore } from './mail-records.ts';
import { EXECUTION_RECORD_KINDS } from '../shared/execution-history.ts';
import { validateExecutionRecord } from './execution-history.ts';
import { validateExecutionRecords, restoreExecutionRecords } from './execution-history-backup.ts';
import { REMOTE_EVIDENCE_KIND, validateRemoteEvidence, restoreRemoteEvidence } from './website-remote-evidence.ts';
import { REMOTE_TEMPLATE_KIND, validateRemoteTemplate, restoreRemoteTemplate } from './website-remote-disclosure.ts';
import { WEBSITE_REQUEST_KIND, validateSavedWebsiteRequest, restoreWebsiteRequest } from './website-requests.ts';
import { validateWebsiteWorkGraph } from './website-work-backup.ts';
import { isSkillArchivePath, validateSkillOverride, validateSkillJournalRoot } from './customer-pack-skill-history.ts';
import { validateCustomerSkillArchiveFile, validateCustomerSkillArchiveSet } from './customer-pack-skill-backup.ts';
import { PRIVATE_BACKUP_MAX_BYTES, PRIVATE_BACKUP_MAX_RECORDS, PRIVATE_BACKUP_MAX_CONTENT_BYTES, PRIVATE_BACKUP_MAX_FILES, PRIVATE_BACKUP_MIN_PASSPHRASE, PRIVATE_BACKUP_MAX_PASSPHRASE, parsePrivateRestoreReceipt, type PrivateWorkspaceBackup, type PrivateBackupReceipt, type PrivateRestoreStatus } from '../shared/private-workspace-backup.ts';

export const PRIVATE_RESTORE_STAGE_FILE = 'private-workspace-restore.json';
export const PRIVATE_RESTORE_RECEIPT_FILE = 'private-workspace-restore-receipt.json';
const MAX_FILE = 8 * 1024 * 1024, MAX_PLAIN = PRIVATE_BACKUP_MAX_CONTENT_BYTES, MAX_PAYLOAD = 64 * 1024 * 1024, MAX_FILES = PRIVATE_BACKUP_MAX_FILES;
const WORKSPACE = 'company-installation/workspace.json';
const DATABASE = 'workflow-state.sqlite';
const STATIC = new Set(['desk.json', WORKSPACE, 'agency-setup.json', 'workspace-views/tabs.json', 'recipes.json', 'job-runs.json', 'work-batches.json', 'loops.json', 'expected-bills.json', 'customer-packs.json', 'vault/USER.md', 'vault/README.md', 'vault/AU-RENTAL-LAW.md']);
const KINDS = new Set(['bank', 'handoff', 'bill-proposal', 'bill-review-draft', DEPARTMENT_WORK_KIND, WEBSITE_REQUEST_KIND, WEBSITE_REMOTE_WORK_KIND, REMOTE_TEMPLATE_KIND, REMOTE_EVIDENCE_KIND, ...SOURCE_BILL_RECORD_KINDS, ...MAIL_RECORD_KINDS, ...EXECUTION_RECORD_KINDS]);
const BILL_KINDS: ReadonlySet<string> = new Set(SOURCE_BILL_RECORD_KINDS);
const GUARDED = ['config.json', 'company-installation/host.json', 'company-installation/peer.json', 'company-installation/seat.json', 'company-installation/enrollment.json'];
const COMPANY_DIRECTORY_GUARD = '$company-directory';
export const PRIVATE_PACK_HISTORY_ROOTS = ['customer-pack-history', 'customer-skill-history'] as const;
/** Shared strict enumeration policy for capture and destination/removal scans. */
export function privateBackupHistoryStorage(path: string): boolean {
  return PRIVATE_PACK_HISTORY_ROOTS.some(root => path === root || path.startsWith(`${root}/`));
}
export function privateBackupHistoryDirectory(parent: string, name: string): boolean {
  return PRIVATE_PACK_HISTORY_ROOTS.some(root => parent === root) && /^[a-z][a-z0-9-]{1,79}$/.test(name) && portableSegment(name);
}
export function privateBackupSourcePaths() { return { staticPaths: [...STATIC], guardedPaths: [...GUARDED] }; }
const INCLUDED = ['Private Desk book and property notes', 'Saved mail work and collected source evidence', 'Bank originals, reviewed copies, bills, review drafts and preparation receipts', 'Portfolio batch sources, saved results and retry history', 'Department preparation history and its reviewed case snapshot', 'Agency settings, saved views, plans and instruction revision history'];
const EXCLUDED = ['Provider keys, connected-account credentials and sign-in sessions', 'Shared office database and company membership', 'Worker installation, authentication, conversations and memory', 'Files outside the listed business folders and external attachments'];
const CHANGES = ['Use this installation’s protected encryption key', 'Clear connected-account selection and setup approvals', 'Pause all schedules and require plan review', 'Retain job history; interrupt unfinished work and close sign-in handoffs', 'Repair the installed instruction pack before running its plans'];
export function privateBackupDescriptions() { return { included: [...INCLUDED], excluded: [...EXCLUDED], restoreChanges: [...CHANGES] }; }
function fail(message: string, status = 409): never { throw Object.assign(new Error(message), { status }); }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: unknown, keys: string[]) => { if (!object(v) || Object.keys(v).sort().join(',') !== keys.sort().join(',')) return fail('The private backup contains unsupported fields.', 400); return v; };
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const json = (value: unknown) => JSON.stringify(value);
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
const hex = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 1 && Number(v) < Number.MAX_SAFE_INTEGER;
function allowed(path: string) {
  if (STATIC.has(path)) return true;
  return isPackArchivePath(path) || isSkillArchivePath(path) ||
    /^company-installation\/private\/(?:mail-workspace|mail-prepared-input|mail-scan-[a-f0-9-]{36})\.json$/.test(path) ||
    /^vault\/(?:properties|owners|decisions)\/[A-Za-z0-9_-]{1,180}\.md$/.test(path) ||
    /^vault\/workflow-inputs\/[A-Za-z0-9_-]{1,100}\.(?:json|csv|txt|md)$/.test(path) ||
    /^vault\/workflow-support\/[a-z][a-z0-9-]{0,63}\/(?:SKILL\.md|LICENSE)$/.test(path);
}
function portableSegment(part: string): boolean {
  return !!part && part !== '.' && part !== '..' && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part);
}
function portable(path: unknown): path is string {
  return typeof path === 'string' && path.length <= 240 && !path.includes('\\') && path.split('/').every(portableSegment) && allowed(path);
}
export { portable as isPrivateBackupPath, validateBusinessFile as validatePrivateBusinessFile };
/** One record at a time keeps v2 archive validation independent of total history size. */
export function validatePrivatePackHistoryFiles(files: { get(path: string): Buffer | undefined; paths(): Iterable<string> }): void {
  const read = (path: string) => { const data = files.get(path); return data === undefined ? undefined : parseJson(data); };
  validateCustomerPackArchiveSet(read('customer-packs.json'), { get: read, paths: () => files.paths() });
  validateCustomerSkillArchiveSet(read('customer-packs.json'), { get: read, paths: () => files.paths() });
}
export function validatePrivateWorkspaceIdentity(value: unknown, workspaceId: string): void {
  const workspace = exact(value, ['version', 'id', 'workerMemberKey']);
  if (workspace.version !== 1 || workspace.id !== workspaceId || !(workspace.workerMemberKey === null || typeof workspace.workerMemberKey === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(workspace.workerMemberKey))) fail('The backup workspace identity is inconsistent.', 400);
}
async function safeParents(path: string) {
  const absolute = resolve(path), root = parse(absolute).root; let cursor = root;
  for (const part of absolute.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    cursor = join(cursor, part);
    try { const stat = await lstat(cursor); if (stat.isSymbolicLink() || !stat.isDirectory()) fail('Private backup storage contains a linked or invalid folder.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
async function bytes(path: string, max = MAX_FILE): Promise<Buffer | undefined> {
  await safeParents(dirname(path));
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > max) fail('A private business file is linked, invalid or too large for this backup.');
    const content = await readFile(path), after = await lstat(path);
    if (content.length > max || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail('Business files changed during the backup. Retry after current work finishes.');
    return content;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
async function write(path: string, content: Buffer) {
  await safeParents(dirname(path)); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await windowsFilePrivacy(dirname(path), 'directory', true);
  await bytes(path, PRIVATE_BACKUP_MAX_BYTES);
  const temp = `${path}.${randomUUID()}.tmp`, file = await open(temp, 'wx', 0o600);
  try {
    await windowsFilePrivacy(temp, 'file', true); await file.writeFile(content); await file.sync(); await file.close();
    await rename(temp, path); fsyncDir(dirname(path));
  } finally { await file.close().catch(() => {}); await unlink(temp).catch(() => {}); }
}
function parseJson(content: Buffer): unknown { try { return JSON.parse(content.toString('utf8')); } catch { return fail('A private business record needs recovery; no partial backup was created.', 503); } }
function validHistory(runs: unknown, jobs: boolean) {
  if (!Array.isArray(runs) || runs.length > (jobs ? 1000 : 10_000)) fail('Saved work history needs recovery.', 400);
  const ids = new Set<string>();
  for (const run of runs) {
    if (!object(run) || typeof run.id !== 'string' || ids.has(run.id) || !['queued','running','awaiting-approval','completed','partial','failed','interrupted','cancelled','missed'].includes(String(run.status)) || typeof run.createdAt !== 'number' || !Number.isFinite(run.createdAt) || typeof run.scheduledFor !== 'number' || !Number.isFinite(run.scheduledFor)) fail('Saved work history needs recovery.', 400);
    ids.add(run.id);
    if (jobs) {
      if (typeof run.jobId !== 'string' || typeof run.jobTitle !== 'string' || !positive(run.jobRevision) || typeof run.idempotencyKey !== 'string' || !positive(run.attempt) || !['shadow','prepare','attended'].includes(String(run.mode)) || !['manual','schedule'].includes(String(run.trigger)) || typeof run.detail !== 'string' || !Array.isArray(run.evidence) || !Array.isArray(run.approvalRequests) || run.approvalRequests.some(v => typeof v !== 'string') || !object(run.spec)) fail('Saved job history needs recovery.', 400);
      const spec = run.spec;
      if (!['title','description','evidence'].every(k => typeof spec[k] === 'string') || !Array.isArray(spec.steps) || spec.steps.some(v => typeof v !== 'string') || !Array.isArray(spec.allowedOrigins) || spec.allowedOrigins.some(v => typeof v !== 'string') || !Array.isArray(spec.capabilities) || !spec.capabilities.length || spec.capabilities.some(v => !(JOB_CAPABILITIES as readonly unknown[]).includes(v)) || !object(spec.limits) || !positive(spec.limits.maxRuntimeMinutes) || Number(spec.limits.maxRuntimeMinutes) > 5 || !positive(spec.limits.maxTurns) || Number(spec.limits.maxTurns) > 12 || run.evidence.some(e => !object(e) || typeof e.note !== 'string' || typeof e.at !== 'number' || !['observation','output','approval','action','denied','asked','note'].includes(String(e.kind)))) fail('Saved job evidence needs recovery.', 400);
    } else if (typeof run.loopId !== 'string' || typeof run.loopName !== 'string' || typeof run.manual !== 'boolean') fail('Saved schedule history needs recovery.', 400);
  }
}
function validateBusinessFile(path: string, value: unknown) {
  if (isSkillArchivePath(path)) validateCustomerSkillArchiveFile(path, value);
  if (isPackArchivePath(path)) {
    const [, packId, name] = path.split('/');
    validateCustomerPackHistoryArchive(value, packId, name.slice(0, -5));
  }
  if (path === 'work-batches.json' && !validStoredWorkBatches(value)) fail('Saved portfolio batch history needs recovery; no partial backup was created.', 400);
  if ((path === 'job-runs.json' || path === 'loops.json') && object(value) && Object.hasOwn(value, 'executionHistory') && value.executionHistory !== 1) fail('Saved execution history uses an unsupported format.', 400);
  if (path === 'agency-setup.json') {
    if (!object(value) || value.version !== 1 || !positive(value.revision) || typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt) || !object(value.settings) || !object(value.reviews)) fail('Saved agency setup needs recovery.', 400);
    validateAgencySettings({ ...value.settings, workflowPackId: value.settings.workflowPackId ?? null });
    for (const [name, review] of Object.entries(value.reviews)) if (!['bank-references','bills-calendar','morning-priorities'].includes(name) || !object(review) || review.settingsRevision !== value.revision || !hex(review.evidenceDigest) || typeof review.reviewedAt !== 'number' || typeof review.actorId !== 'string') fail('Saved agency reviews need recovery.', 400);
  } else if (path === 'workspace-views/tabs.json') { if (!object(value)) fail('Saved views need recovery.', 400); parseWorkspaceTabs(value.state); }
  else if (path === 'recipes.json') {
    const list = Array.isArray(value) ? value : object(value) && Array.isArray(value.recipes) ? value.recipes : null;
    if (!list || list.length > 5000 || new Set(list.map(r => object(r) ? r.id : null)).size !== list.length) fail('Saved plans need recovery.', 400);
    for (const r of list) { if (!object(r) || typeof r.id !== 'string' || !r.id || !positive(r.revision) || typeof r.createdAt !== 'number' || !['active','paused','shadow'].includes(String(r.status))) fail('Saved plan identity needs recovery.', 400); validateRecipe(r); }
  } else if (path === 'job-runs.json') { if (Array.isArray(value)) validHistory(value, true); else { if (!object(value) || value.version !== 1) fail('Saved job history needs recovery.', 400); validHistory(value.runs, true); } }
  else if (path === 'loops.json') {
    if (!object(value) || ![1,2,3].includes(Number(value.version)) || !object(value.state)) fail('Saved schedules need recovery.', 400);
    if (value.timezone !== undefined) { try { new Intl.DateTimeFormat('en', { timeZone: String(value.timezone) }); } catch { fail('Saved schedule timezone needs recovery.', 400); } }
    for (const [id, state] of Object.entries(value.state)) if (!/^[\w-]{1,200}$/.test(id) || !object(state) || typeof state.enabled !== 'boolean' || typeof state.handledThrough !== 'number' || !Number.isFinite(state.handledThrough)) fail('Saved schedule state needs recovery.', 400);
    validHistory(value.runs, false);
  } else if (path === 'expected-bills.json') {
    if (!object(value) || value.version !== 1 || !Array.isArray(value.bills)) fail('Saved bills need recovery.', 400);
    const ids = new Set();
    for (const b of value.bills) {
      if (!object(b) || !['id','propertyId','kind','note'].every(k => typeof b[k] === 'string') || ids.has(b.id) || !(BILL_STATUSES as readonly unknown[]).includes(b.status) || !(b.sourceRef === null || typeof b.sourceRef === 'string') || !['windowStartAt','windowEndAt','amountCents'].every(k => b[k] === null || typeof b[k] === 'number' && Number.isFinite(b[k])) || !['createdAt','updatedAt'].every(k => typeof b[k] === 'number' && Number.isFinite(b[k]))) fail('Saved bill facts need recovery.', 400);
      ids.add(b.id);
    }
  } else if (path === 'customer-packs.json') {
    validateSkillJournalRoot(value);
    for (const [id, entry] of Object.entries(value.installs as Record<string, unknown>)) {
      if (!object(entry) || entry.version !== 1 || entry.phase !== 'installed' || entry.upgrade || entry.transition || entry.archiveIntent || entry.skillArchiveIntent || entry.initialApprovalReset || !hex(entry.digest) || typeof entry.installedAt !== 'string') fail('Finish or recover the instruction pack change before creating a backup.', 409);
      const pack = validateCustomerPack(entry.pack); if (pack.id !== id || hash(json(pack)) !== entry.digest) fail('The published workflow pack failed its integrity check.', 400);
      validateCustomerPackUpgradeJournal(entry);
      if (!object(entry.receipt) || !['addedRecipes','installedSkills','preservedRecipes'].every(k => Array.isArray((entry.receipt as Record<string, unknown>)[k]))) fail('The pack installation receipt needs recovery.', 400);
      if (entry.overrides !== undefined && !object(entry.overrides)) fail('The reviewed skill history needs recovery.', 400);
      for (const [skillId, override] of Object.entries((entry.overrides ?? {}) as Record<string, unknown>)) {
        if (!pack.skills.some(s => s.id === skillId)) fail('The reviewed skill history failed its integrity check.', 400);
        validateSkillOverride(override);
      }
    }
  }
}
interface SavedFile { path: string; sha256: string; bytes: number; base64: string }
interface SavedRecord { id: string; kind: string; revision: number; payload: EncryptedEnvelope }
interface Snapshot { version: 1; createdAt: string; workspaceId: string; keyHex: string; files: SavedFile[]; databasePresent: boolean; records: SavedRecord[] }
interface Stage { version: 1; state: 'staged' | 'applying'; receipt: PrivateBackupReceipt; baseline: Record<string, string>; files: SavedFile[]; removals: string[] }
const executionFiles = (files: SavedFile[]) => Object.fromEntries(files.filter(f => f.path === 'job-runs.json' || f.path === 'loops.json').map(f => [f.path, Buffer.from(f.base64, 'base64').toString('utf8')]));
function file(path: string, data: Buffer): SavedFile { return { path, sha256: hash(data), bytes: data.length, base64: data.toString('base64') }; }
function decodeFile(value: unknown, generated = false): SavedFile {
  const f = exact(value, ['path', 'sha256', 'bytes', 'base64']);
  if (!(portable(f.path) || generated && f.path === DATABASE) || !hex(f.sha256) || !Number.isSafeInteger(f.bytes) || Number(f.bytes) < 0 || Number(f.bytes) > (generated && f.path === DATABASE ? MAX_PLAIN : MAX_FILE) || typeof f.base64 !== 'string' || f.base64.length > PRIVATE_BACKUP_MAX_BYTES) return fail('The backup file manifest is invalid.', 400);
  const data = Buffer.from(f.base64, 'base64');
  if (data.toString('base64') !== f.base64 || data.length !== f.bytes || hash(data) !== f.sha256) return fail('A backup file failed its integrity check.', 400);
  return f as unknown as SavedFile;
}
async function filesAt(directory: string): Promise<SavedFile[]> {
  const paths = new Set<string>();
  for (const path of STATIC) if (await bytes(join(directory, path)) !== undefined) paths.add(path);
  async function walk(relative: string, depth: number) {
    const folder = join(directory, relative); await safeParents(folder);
    let entries; try { entries = await readdir(folder, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const path = `${relative}/${entry.name}`;
      if (privateBackupHistoryStorage(relative) && !allowed(path) && !(privateBackupHistoryDirectory(relative, entry.name) && entry.isDirectory())) fail('Unrecognized workflow pack archive storage needs recovery before backup.');
      if (allowed(path)) paths.add(path);
      else if (depth && entry.isDirectory()) await walk(path, depth - 1);
      else if (depth && entry.isSymbolicLink()) fail('Workflow support contains a linked folder.');
      else if (/^company-installation\/private\/mail-/.test(path)) fail('An unrecognized mail evidence file needs service review before backup.');
    }
  }
  for (const path of ['company-installation/private', 'vault/properties', 'vault/owners', 'vault/decisions', 'vault/workflow-inputs']) await walk(path, 0);
  await walk('vault/workflow-support', 1);
  for (const root of PRIVATE_PACK_HISTORY_ROOTS) await walk(root, 1);
  if (paths.size > MAX_FILES) fail('This business snapshot exceeds the supported file count. Use assisted backup; no partial export was issued.');
  const result: SavedFile[] = []; let total = 0;
  for (const path of [...paths].sort()) { const content = await bytes(join(directory, path)); if (!content) fail('Business files changed during backup.'); total += content.length; if (total > MAX_PLAIN) fail('This business snapshot exceeds 48 MB. Use assisted backup; no partial export was issued.'); result.push(file(path, content)); }
  return result;
}
async function recordsAt(directory: string, key: Buffer): Promise<{ present: boolean; records: SavedRecord[] }> {
  if (await bytes(join(directory, DATABASE), MAX_PLAIN) === undefined) return { present: false, records: [] };
  const db = new DatabaseSync(join(directory, DATABASE), { readOnly: true });
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; BEGIN;');
    const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
    const schema = db.prepare("SELECT type,name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
    if (version.user_version !== 1 || schema.some(r => r.type !== 'table' || r.name !== 'workflow_records')) fail('The workflow database schema needs a compatible backup version.');
    const count = db.prepare('SELECT COUNT(*) AS count FROM workflow_records').get() as { count: number };
    if (count.count > PRIVATE_BACKUP_MAX_RECORDS) fail('This workspace exceeds the 5,000-record limit of private backup version 1. Contact support for assisted backup. Existing history is preserved; no partial backup was produced.');
    // Preserve insertion order: execution history cursors use the SQLite rowid.
    // Restore recreates logical rows in this order, without importing SQL/schema.
    const records = db.prepare('SELECT id,kind,revision,payload FROM workflow_records ORDER BY rowid').all().map(r => validateRecord({ ...r, payload: parseJson(Buffer.from(String(r.payload))) }, key));
    if (Buffer.byteLength(json(records)) > MAX_PLAIN) fail('Workflow history exceeds the 48 MB limit of private backup version 1. Contact support for assisted backup. Existing history is preserved; no partial backup was produced.');
    db.exec('COMMIT'); return { present: true, records };
  } finally { db.close(); }
}
function validateRecord(value: unknown, key: Buffer): SavedRecord {
  const r = exact(value, ['id', 'kind', 'revision', 'payload']);
  if (typeof r.kind !== 'string' || !KINDS.has(r.kind) || typeof r.id !== 'string' || !/^[a-zA-Z0-9:_-]{1,180}$/.test(r.id) || !positive(r.revision) || !isEncryptedEnvelope(r.payload)) return fail('Unknown or invalid workflow history cannot be exported or restored.', 400);
  if (json(r.payload).length > WORKFLOW_MAX_ENCRYPTED_RECORD_LENGTH) return fail('An encrypted workflow record exceeds the supported storage limit. Contact support for assisted recovery; no partial restore was prepared.', 413);
  let plain: unknown; try { plain = decryptJson(key, r.payload); } catch { return fail('Workflow history does not open with this business key.', 400); }
  validatePrivateLogicalRecord({ id: r.id, kind: r.kind, revision: r.revision, value: plain });
  return r as unknown as SavedRecord;
}
/** Shared per-record policy for v1 envelopes and the v2 logical catalog. Complete
 * graph validation and destination encrypted-size checks remain separate. */
export function validatePrivateLogicalRecord(value: unknown): { id: string; kind: string; revision: number; value: Record<string, unknown> } {
  const r = exact(value, ['id', 'kind', 'revision', 'value']);
  if (typeof r.kind !== 'string' || !KINDS.has(r.kind) || typeof r.id !== 'string' || !/^[a-zA-Z0-9:_-]{1,180}$/.test(r.id) || !positive(r.revision)) return fail('Unknown or invalid workflow history cannot be exported or restored.', 400);
  const plain = r.value;
  if (!object(plain) || Buffer.byteLength(json(plain)) > MAX_FILE) return fail('The workflow history payload is invalid.', 400);
  if (r.kind.startsWith('execution-')) validateExecutionRecord(r.kind, plain);
  if (BILL_KINDS.has(r.kind)) validateSourceBillRecord(r.kind, r.id, Number(r.revision), plain);
  if (r.kind === 'bank') validateSavedBankBatch(r.id, plain);
  if (r.kind === 'bill-proposal') validateSavedBillProposal(r.id, plain);
  if (r.kind === REMOTE_EVIDENCE_KIND) validateRemoteEvidence(r.id, plain);
  if (r.kind === REMOTE_TEMPLATE_KIND) validateRemoteTemplate(r.id, plain);
  if (r.kind === WEBSITE_REMOTE_WORK_KIND) validateSavedWebsiteRemoteWork(r.id, plain);
  if (r.kind === DEPARTMENT_WORK_KIND) { const department: unknown = plain; validateSavedDepartmentWork(r.id, department); }
  if (r.kind === WEBSITE_REQUEST_KIND) validateSavedWebsiteRequest(r.id, plain);
  if (r.kind === 'bill-review-draft') validateSavedBillReviewDraft(r.id, Number(r.revision), plain);
  if (r.kind === 'handoff' && (plain.version !== 1 || !['runId','threadId','botId','detail'].every(k => typeof plain[k] === 'string') || !positive(plain.jobRevision) || !['login','mfa'].includes(String(plain.reason)) || !['releasing','awaiting_login','checking','verified','resuming','recovery_required','stopped','closed'].includes(String(plain.state)))) fail('The sign-in handoff receipt needs recovery.', 400);
  return { id: r.id, kind: r.kind, revision: Number(r.revision), value: plain };
}
function validateSnapshot(value: unknown): Snapshot {
  const s = exact(value, ['version', 'createdAt', 'workspaceId', 'keyHex', 'files', 'databasePresent', 'records']);
  if (s.version !== 1 || !uuid(s.workspaceId) || !hex(s.keyHex) || typeof s.createdAt !== 'string' || !Number.isFinite(Date.parse(s.createdAt)) || !Array.isArray(s.files) || s.files.length > MAX_FILES || !Array.isArray(s.records) || s.records.length > PRIVATE_BACKUP_MAX_RECORDS || typeof s.databasePresent !== 'boolean' || !s.databasePresent && s.records.length) return fail('The private backup manifest is invalid.', 400);
  const files = s.files.map(f => decodeFile(f)), key = Buffer.from(s.keyHex, 'hex');
  try {
    const records = s.records.map(r => validateRecord(r, key));
    if (new Set(files.map(f => f.path.toLowerCase())).size !== files.length || new Set(records.map(r => r.id)).size !== records.length || files.reduce((sum, f) => sum + f.bytes, 0) > MAX_PLAIN) fail('The backup contains duplicate paths or excessive data.', 400);
    const identity = files.find(f => f.path === WORKSPACE), desk = files.find(f => f.path === 'desk.json');
    if (!identity || !desk) fail('The backup must contain its private workspace identity and Desk book.', 400);
    validatePrivateWorkspaceIdentity(parseJson(Buffer.from(identity.base64, 'base64')), s.workspaceId);
    for (const f of files) {
      if (!f.path.endsWith('.json')) continue;
      const value = parseJson(Buffer.from(f.base64, 'base64'));
      if (f.path === 'desk.json') {
        try { decodeDeskPlain(decryptJson(key, value as EncryptedEnvelope), { properties: [], ledger: [] }, 'UTC'); } catch { fail('The saved Desk book is damaged or does not match the backup key.', 400); }
      } else if (f.path.startsWith('company-installation/private/')) {
        let plain; try { plain = decryptJson(key, value as EncryptedEnvelope); } catch { fail('Saved mail evidence does not match its backup key.', 400); }
        const envelope = exact(plain, ['name', 'value']);
        if (envelope.name !== f.path.split('/').at(-1)!.slice(0, -5) || !object(envelope.value)) fail('Saved mail evidence has an invalid identity.', 400);
        if (f.path.endsWith('/mail-workspace.json') && envelope.value.workspaceId !== s.workspaceId) fail('Saved mail work belongs to another private workspace.', 400);
      } else if (['agency-setup.json', 'workspace-views/tabs.json'].includes(f.path) && (!object(value) || value.workspaceId !== s.workspaceId)) fail('Saved settings belong to another private workspace.', 400);
      validateBusinessFile(f.path, value);
    }
    const packFiles = new Map(files.map(f => [f.path, f]));
    validatePrivatePackHistoryFiles({ get: path => { const saved = packFiles.get(path); return saved ? Buffer.from(saved.base64, 'base64') : undefined; }, paths: () => packFiles.keys() });
    const logicalRecords = records.map(r => ({ id: r.id, kind: r.kind, revision: r.revision, value: decryptJson(key, r.payload) }));
    for (const row of logicalRecords) {
      if (row.kind !== 'bill-review-draft') continue;
      const draft = validateSavedBillReviewDraft(row.id, row.revision, row.value, s.workspaceId as string);
      const request = draft.proposalRequest;
      if (request) {
        const intent = logicalRecords.find(record => record.kind === 'bill-proposal' && record.id === `bill-proposal:${request.requestId}`);
        validateBillReviewDraftProposalLink(draft, intent);
      }
    }
    validateBackupMail(files, key, s.workspaceId, logicalRecords);
    validateSourceBillRecords(logicalRecords);
    const banks = new Map(logicalRecords.filter(record=>record.kind === 'bank').map(record=>[record.id,record]));
    for (const record of banks.values()) validateBankReviewLinks(record,id=>banks.get(id));
    validateExecutionRecords(logicalRecords, executionFiles(files));
    const logicalIndex = new Map(logicalRecords.map(row=>[row.id,row]));
    validateWebsiteWorkGraph({get:(kind,id)=>{const row=logicalIndex.get(id);return row?.kind===kind?row:undefined;},iterate:kind=>logicalRecords.filter(row=>row.kind===kind)},s.workspaceId as string);
    validateDepartmentWorkGraph({get:(kind,id)=>{const row=logicalIndex.get(id);return row?.kind===kind?row:undefined;},iterate:kind=>logicalRecords.filter(row=>row.kind===kind)},s.workspaceId as string);
    return { ...s, files, records } as unknown as Snapshot;
  } finally { key.fill(0); }
}
async function passphraseKey(passphrase: unknown, salt: Buffer) {
  if (typeof passphrase !== 'string' || passphrase.length < PRIVATE_BACKUP_MIN_PASSPHRASE || passphrase.length > PRIVATE_BACKUP_MAX_PASSPHRASE) return fail('Use a backup passphrase of 16–256 characters.', 400);
  return new Promise<Buffer>((resolveKey, reject) => scrypt(passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolveKey(key)));
}
function receipt(snapshot: Snapshot, digest: string): PrivateBackupReceipt {
  return { digest, createdAt: snapshot.createdAt, workspaceId: snapshot.workspaceId, fileCount: snapshot.files.length + Number(snapshot.databasePresent), recordCount: snapshot.records.length,
    plainBytes: snapshot.files.reduce((sum, f) => sum + f.bytes, 0) + Buffer.byteLength(json(snapshot.records)), included: INCLUDED, excluded: EXCLUDED, restoreChanges: CHANGES };
}
async function unpack(value: unknown, passphrase: unknown) {
  if (Buffer.byteLength(json(value) ?? '') > PRIVATE_BACKUP_MAX_BYTES) fail('Choose a private backup no larger than 96 MB.', 413);
  const b = exact(value, ['format', 'version', 'kdf', 'salt', 'payload']);
  if (b.format !== 'realbud-private-business' || b.version !== 1 || b.kdf !== 'scrypt-32768-8-1' || typeof b.salt !== 'string' || !/^[a-f0-9]{32}$/.test(b.salt) || !isEncryptedEnvelope(b.payload)) fail('This is not a supported private business backup.', 400);
  const key = await passphraseKey(passphrase, Buffer.from(b.salt, 'hex'));
  try {
    let value; try { value = decryptJson(key, b.payload); } catch { return fail('The backup passphrase or integrity check failed. Existing records were not changed.', 400); }
    if (Buffer.byteLength(json(value)) > MAX_PAYLOAD) fail('The decoded backup is too large.', 413);
    const snapshot = validateSnapshot(value); return { snapshot, receipt: receipt(snapshot, hash(json(b))) };
  } finally { key.fill(0); }
}

/** Internal v1 compatibility seam. Authenticate and validate the entire legacy
 * graph before visiting it; never return its embedded installation key. File
 * buffers are borrowed until each awaited visitor returns, then cleared. */
export async function visitLegacyPrivateBackup(value: unknown, passphrase: unknown, visitor: {
  begin(metadata: { createdAt: string; workspaceId: string; databasePresent: boolean }): void | Promise<void>;
  file(file: { path: string; encoding: 'bytes' | 'json'; data: Buffer }): void | Promise<void>;
  record(record: { id: string; kind: string; revision: number; value: unknown }): void | Promise<void>;
}, signal?: AbortSignal): Promise<PrivateBackupReceipt> {
  signal?.throwIfAborted();
  const decoded = await unpack(value, passphrase); signal?.throwIfAborted();
  const sourceKey = Buffer.from(decoded.snapshot.keyHex, 'hex');
  try {
    const s = decoded.snapshot;
    await visitor.begin({ createdAt: s.createdAt, workspaceId: s.workspaceId, databasePresent: s.databasePresent }); signal?.throwIfAborted();
    for (const file of s.files) {
      signal?.throwIfAborted(); const bytes = Buffer.from(file.base64, 'base64'); let logical = bytes;
      try {
        const protectedFile = file.path === 'desk.json' || file.path.startsWith('company-installation/private/');
        if (protectedFile) logical = Buffer.from(JSON.stringify(decryptJson(sourceKey, parseJson(bytes) as EncryptedEnvelope)));
        await visitor.file({ path: file.path, encoding: protectedFile ? 'json' : 'bytes', data: logical }); signal?.throwIfAborted();
      } finally { logical.fill(0); bytes.fill(0); }
    }
    for (const row of s.records) {
      signal?.throwIfAborted();
      await visitor.record({ id: row.id, kind: row.kind, revision: row.revision, value: decryptJson(sourceKey, row.payload) }); signal?.throwIfAborted();
    }
    return structuredClone(decoded.receipt);
  } finally { sourceKey.fill(0); }
}
function resetRuns(value: unknown, at: number): unknown {
  if (!Array.isArray(value)) return fail('The saved execution history needs recovery.', 400);
  return value.map(run => {
    if (!object(run) || typeof run.status !== 'string') return fail('The saved execution history needs recovery.', 400);
    return ['running', 'queued'].includes(run.status) ? { ...run, status: 'interrupted', finishedAt: at, detail: 'Interrupted by private workspace restore; review before starting new work.' } : run;
  });
}
async function restoredFiles(s: Snapshot, targetKey: Buffer, directory: string, at: number): Promise<SavedFile[]> {
  const sourceKey = Buffer.from(s.keyHex, 'hex'); const output: SavedFile[] = [];
  try {
    for (const f of s.files) {
      let content = Buffer.from(f.base64, 'base64');
      if (f.path.endsWith('.json')) {
        let value = parseJson(content);
        if (f.path === 'desk.json') {
          const decoded = decodeDeskPlain(decryptJson(sourceKey, value as EncryptedEnvelope), { properties: [], ledger: [] }, 'UTC'), book = decoded.data;
          if (!positive(book.revision)) fail('The Desk book revision needs recovery.', 400);
          book.revision++; book.hands = 'held'; book.handsDetail = 'Private workspace restored. Reconnect sources and review work before running.';
          if (decoded.version === 3) {
            decoded.data.handoffs = decoded.data.handoffs.map(h => h.usedAt ? h : { ...h, invalidatedAt: at, verification: 'invalidated', authorization: { ...h.authorization, expiresAt: 0 } });
            decoded.data.portalRecipes = decoded.data.portalRecipes.map(r => ({ ...r, published: false }));
            decoded.data.cases = decoded.data.cases.map(c => ['approved','preparing','handoff-ready'].includes(c.state) ? { ...c, state: 'held', holdReason: 'workspace-restored', detail: 'Review this saved work again on the restored installation.', updatedAt: at } : c);
          } else {
            decoded.data.capabilities = decoded.data.capabilities.map(c => c.usedAt ? c : { ...c, invalidatedAt: at, expiresAt: 0 });
            decoded.data.recipes = decoded.data.recipes.map(r => ({ ...r, published: false }));
            decoded.data.workItems = decoded.data.workItems.map(w => ['approved','preparing','handoff-ready'].includes(w.state) ? { ...w, state: 'held', updatedAt: at } : w);
          }
          decodeDeskPlain(book, { properties: [], ledger: [] }, 'UTC'); value = encryptJson(targetKey, book);
        } else if (f.path.startsWith('company-installation/private/')) value = encryptJson(targetKey, decryptJson(sourceKey, value as EncryptedEnvelope));
        else if (f.path === 'agency-setup.json') {
          if (!object(value) || !object(value.settings) || !positive(value.revision)) fail('Saved agency settings need recovery.', 400);
          value = { ...value, revision: value.revision + 1, updatedAt: at, settings: { ...value.settings, gmailAccountId: null }, reviews: {} };
        } else if (f.path === 'recipes.json') {
          const list = Array.isArray(value) ? value : object(value) && Array.isArray(value.recipes) ? value.recipes : null;
          if (!list) fail('Saved plans need recovery.', 400);
          value = { recipes: list.map(r => { if (!object(r) || !positive(r.revision)) return fail('Saved plan revisions need recovery.', 400); return { ...r, revision: r.revision + 1, updatedAt: at, status: 'paused', schedule: null, planApprovedAt: null, approvedRevision: null, attachment: null, submitAcknowledgedAt: null }; }) };
        } else if (f.path === 'job-runs.json') { if (Array.isArray(value)) value = { version: 1, runs: resetRuns(value, at) }; else { if (!object(value)) fail('Saved job receipts need recovery.', 400); value = { ...value, runs: resetRuns(value.runs, at) }; } }
        else if (f.path === 'work-batches.json') {
          try { value = restoreWorkBatches(value, at); }
          catch { fail('Saved portfolio batch history needs recovery; no partial restore was prepared.', 400); }
        }
        else if (f.path === 'loops.json') {
          if (!object(value) || !object(value.state)) fail('Saved schedules need recovery.', 400);
          value = { ...value, state: Object.fromEntries(Object.entries(value.state).map(([id, state]) => { if (!object(state)) return fail('Saved schedules need recovery.', 400); return [id, { ...state, enabled: false }]; })), runs: resetRuns(value.runs, at) };
        }
        content = Buffer.from(json(value));
      }
      output.push(file(f.path, content));
    }
    const loops = output.find(f => f.path === 'loops.json');
    const state = loops ? parseJson(Buffer.from(loops.base64, 'base64')) as Record<string, unknown> : { version: 3, timezone: 'UTC', state: {}, runs: [] };
    if (!object(state.state)) fail('Saved schedules need recovery.', 400);
    for (const id of ['morning-arrears', 'owner-letter', 'inbound-triage']) state.state[id] = { ...(object(state.state[id]) ? state.state[id] : {}), enabled: false, handledThrough: at };
    const safeLoops = file('loops.json', Buffer.from(json(state))); if (loops) output[output.indexOf(loops)] = safeLoops; else output.push(safeLoops);
    const execution = restoreExecutionRecords(s.records.map(r => ({ id: r.id, kind: r.kind, revision: r.revision, value: decryptJson(sourceKey, r.payload) })), executionFiles(s.files), executionFiles(output), at);
    const restoredRecords = interruptMailRecordsForRestore(execution.records, s.workspaceId, at).map(row=>row.kind===DEPARTMENT_WORK_KIND?{...row,revision:row.revision+1,value:restoreDepartmentWork(row.id,row.value)}:row.kind===WEBSITE_REMOTE_WORK_KIND?{...row,revision:row.revision+1,value:restoreWebsiteRemoteWork(row.id,row.value,new Date(at).toISOString())}:row.kind===WEBSITE_REQUEST_KIND?{...row,revision:row.revision+1,value:restoreWebsiteRequest(row.id,row.value,new Date(at).toISOString())}:row.kind===REMOTE_TEMPLATE_KIND?{...row,revision:row.revision+1,value:restoreRemoteTemplate(row.id,row.value)}:row.kind===REMOTE_EVIDENCE_KIND?{...row,revision:row.revision+1,value:restoreRemoteEvidence(row.id,row.value)}:row);
    // Bill facts, source aliases, reviews and lookup reservations remain one
    // validated graph while generic restoration rekeys the logical records.
    validateSourceBillRecords(restoredRecords);
    for (const [path, content] of Object.entries(execution.files)) {
      const index = output.findIndex(f => f.path === path), restored = file(path, Buffer.from(content));
      if (index < 0) output.push(restored); else output[index] = restored;
    }
    validateBackupMail(output, targetKey, s.workspaceId, restoredRecords);
    if (s.databasePresent) {
      const temp = join(directory, `.private-restore-database-${randomUUID()}.sqlite`); await safeParents(directory);
      try {
        const db = new DatabaseSync(temp);
        try {
          await chmod(temp, 0o600); await windowsFilePrivacy(temp, 'file', true);
          db.exec('PRAGMA synchronous=FULL; CREATE TABLE workflow_records (id TEXT PRIMARY KEY, kind TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL); PRAGMA user_version=1; BEGIN IMMEDIATE;');
          const insert = db.prepare('INSERT INTO workflow_records VALUES(?,?,?,?)');
          for (const row of restoredRecords) {
            let value = row.value as Record<string, unknown>;
            if (row.kind === 'handoff') value = { ...value, state: 'closed', binding: undefined, updatedAt: at, detail: 'Closed during private workspace restore. Sign in again before any attended run.' };
            const payload = json(encryptJson(targetKey, value));
            // Restore transformations must obey the same durable limit as a
            // normal create/update, including their added recovery metadata.
            if (payload.length > WORKFLOW_MAX_ENCRYPTED_RECORD_LENGTH) fail('An encrypted workflow record exceeds the supported storage limit after recovery. Contact support for assisted recovery; no partial restore was prepared.', 413);
            insert.run(row.id, row.kind, row.revision, payload);
          }
          db.exec('COMMIT');
        } finally { db.close(); }
        const data = await bytes(temp, MAX_PLAIN); if (!data) fail('The restored workflow database could not be prepared.'); output.push(file(DATABASE, data));
      } finally { await rm(temp, { force: true }); await rm(`${temp}-journal`, { force: true }); }
    }
    return output.sort((a, b) => a.path.localeCompare(b.path));
  } finally { sourceKey.fill(0); }
}
async function fingerprint(directory: string): Promise<Record<string, string>> {
  const files = await filesAt(directory), result = Object.fromEntries(files.map(f => [f.path, f.sha256]));
  for (const path of [DATABASE, ...GUARDED]) { const data = await bytes(join(directory, path), path === DATABASE ? MAX_PLAIN : MAX_FILE); if (data) result[path] = hash(data); }
  const company = join(directory, 'company-installation'); await safeParents(company);
  let names: string[] = []; try { names = await readdir(company); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const entries = [];
  for (const name of names.filter(n => !['workspace.json', 'private'].includes(n)).sort()) {
    const stat = await lstat(join(company, name));
    if (stat.isSymbolicLink()) fail('The office installation contains a linked entry.');
    entries.push([name, stat.isDirectory() ? 'directory' : 'file', stat.size, stat.mtimeMs, stat.ctimeMs]);
  }
  result[COMPANY_DIRECTORY_GUARD] = hash(json(entries));
  return result;
}
async function readStage(directory: string, key: Buffer): Promise<Stage | null> {
  const data = await bytes(join(directory, PRIVATE_RESTORE_STAGE_FILE), PRIVATE_BACKUP_MAX_BYTES); if (!data) return null;
  let stage: unknown; try { stage = decryptJson(key, parseJson(data) as EncryptedEnvelope); } catch { return fail('The staged restore needs recovery. Startup remains held; original backup and target files were preserved.', 503); }
  const s = exact(stage, ['version', 'state', 'receipt', 'baseline', 'files', 'removals']);
  if (s.version !== 1 || !['staged', 'applying'].includes(String(s.state)) || !object(s.receipt) || !hex(s.receipt.digest) || !object(s.baseline) || !Array.isArray(s.files) || s.files.length > MAX_FILES + 2 || !Array.isArray(s.removals)) fail('The staged restore manifest needs recovery.', 503);
  const files = s.files.map(f => decodeFile(f, true));
  if (new Set(files.map(f => f.path.toLowerCase())).size !== files.length || s.removals.some(p => typeof p !== 'string' || !(portable(p) || p === DATABASE)) || Object.entries(s.baseline).some(([path, digest]) => !(portable(path) || path === DATABASE || GUARDED.includes(path) || path === COMPANY_DIRECTORY_GUARD) || !hex(digest))) fail('The staged restore paths need recovery.', 503);
  return { ...s, files } as unknown as Stage;
}
async function saveStage(directory: string, key: Buffer, stage: Stage) {
  // Authority resets can expand an otherwise valid input. Refuse before
  // publishing a staged file that the cold reader would be unable to accept.
  for (const file of stage.files) {
    if (file.bytes > (file.path === DATABASE ? MAX_PLAIN : MAX_FILE)) fail('A restored business file exceeds its supported size. No restore was staged.', 413);
    decodeFile(file, true);
  }
  const data = Buffer.from(json(encryptJson(key, stage))); if (data.length > PRIVATE_BACKUP_MAX_BYTES) fail('The staged restore exceeds the supported size.', 413);
  await write(join(directory, PRIVATE_RESTORE_STAGE_FILE), data);
}
export interface PrivateWorkspaceBackupOptions {
  directory: string; key: () => Buffer; workspaceId: string;
  /** Synchronous generation changes before any business/authority mutation. */
  epoch: () => string;
  assertIdle: () => void;
  /** Host verifies no real private business data, office enrollment or work. */
  assertFresh: () => void;
  /** Host admission barrier for a consistent export. No restore hold is cleared. */
  snapshotLease?: () => Promise<{ assertCurrent(): void; release(): void }>;
  now?: () => number;
}
export function createPrivateWorkspaceBackup(options: PrivateWorkspaceBackupOptions) {
  const directory = resolve(options.directory), now = options.now ?? Date.now;
  let active = false;
  async function exclusive<T>(work: () => Promise<T>) { if (active) fail('Another private backup operation is in progress.'); active = true; try { return await work(); } finally { active = false; } }
  async function noStage(key: Buffer) { if (await readStage(directory, key) || await bytes(join(directory, 'private-workspace-restore-v2.json'), 64 * 1024)) fail('A private restore is staged. Restart RealBud before doing more work.'); }
  return {
    async status(): Promise<PrivateRestoreStatus> {
      const stage = await readStage(directory, options.key());
      if (stage) return { state: stage.state, receipt: stage.receipt, completed: null };
      let completed = null;
      let completionWarning: string | undefined;
      try {
        const data = await bytes(join(directory, PRIVATE_RESTORE_RECEIPT_FILE), 512 * 1024);
        if (data) {
          completed = parsePrivateRestoreReceipt(parseJson(data));
          if (!completed) throw new Error('Invalid restore receipt');
        }
      } catch {
        // Historical metadata is advisory. Keep recovery export available;
        // export validates the actual records independently. Stage failures above
        // still hold startup and must never be softened into this warning.
        completionWarning = 'The previous restore receipt could not be read or verified. Its files are preserved, but completion cannot be confirmed. You can still back up valid business records.';
      }
      return { state: 'none', receipt: null, completed, ...(completionWarning ? { completionWarning } : {}) };
    },
    exportBackup(passphrase: unknown) { return exclusive(async () => {
      options.assertIdle(); const lease = await options.snapshotLease?.();
      let key: Buffer | undefined;
      try {
        const generation = options.epoch(); key = Buffer.from(options.key());
        lease?.assertCurrent();
        await noStage(key); const files = await filesAt(directory), database = await recordsAt(directory, key);
        const snapshot = validateSnapshot({ version: 1, createdAt: new Date(now()).toISOString(), workspaceId: options.workspaceId, keyHex: key.toString('hex'), files, databasePresent: database.present, records: database.records });
        if (Buffer.byteLength(json(snapshot)) > MAX_PAYLOAD) fail('This business snapshot exceeds the supported size. Use assisted backup.');
        const salt = randomBytes(16), encryptionKey = await passphraseKey(passphrase, salt);
        let backup: PrivateWorkspaceBackup;
        try { backup = { format: 'realbud-private-business', version: 1, kdf: 'scrypt-32768-8-1', salt: salt.toString('hex'), payload: encryptJson(encryptionKey, snapshot) }; } finally { encryptionKey.fill(0); }
        lease?.assertCurrent(); options.assertIdle();
        const again = await filesAt(directory), currentDb = await recordsAt(directory, key);
        lease?.assertCurrent();
        if (generation !== options.epoch() || json(files) !== json(again) || json(database) !== json(currentDb)) fail('Business records changed during backup. Retry after current work finishes.');
        if (Buffer.byteLength(json(backup)) > PRIVATE_BACKUP_MAX_BYTES) fail('This encrypted backup exceeds 96 MB. No partial backup was issued.', 413);
        return { backup, receipt: receipt(snapshot, hash(json(backup))) };
      } finally { key?.fill(0); lease?.release(); }
    }); },
    previewBackup(backup: unknown, passphrase: unknown) { return exclusive(async () => (await unpack(backup, passphrase)).receipt); },
    stageRestore(input: { backup: unknown; passphrase: unknown; expectedDigest: unknown }) { return exclusive(async () => {
      options.assertIdle(); options.assertFresh(); const generation = options.epoch(), key = Buffer.from(options.key());
      try {
        await noStage(key);
        if (await bytes(join(directory, PRIVATE_BACKUP_COMPLETION_FILE))) fail('Finish recording the previous restore before preparing another restore.');
        const baseline = await fingerprint(directory), decoded = await unpack(input.backup, input.passphrase);
        if (input.expectedDigest !== decoded.receipt.digest) fail('The selected backup changed. Preview it again before restoring.');
        const files = await restoredFiles(decoded.snapshot, key, directory, now());
        options.assertIdle(); options.assertFresh();
        if (generation !== options.epoch() || json(baseline) !== json(await fingerprint(directory))) fail('The fresh target changed during restore preparation. No records were replaced.');
        const paths = new Set(files.map(f => f.path)), removals = Object.keys(baseline).filter(path => (portable(path) || path === DATABASE) && !paths.has(path));
        await saveStage(directory, key, { version: 1, state: 'staged', receipt: decoded.receipt, baseline, files, removals });
        return { needsRestart: true as const, receipt: decoded.receipt };
      } finally { key.fill(0); }
    }); },
  };
}

/** Must run before Desk, clocks, WorkflowDatabase or company installation open.
 * A partial restore resumes using the unchanged target OS-backed key. */
export async function applyStagedPrivateRestore(options: { directory: string; key: Buffer; afterWrite?: (path: string) => void }): Promise<{ restored: boolean; receipt?: PrivateBackupReceipt }> {
  const directory = resolve(options.directory), key = Buffer.from(options.key), stage = await readStage(directory, key);
  if (!stage) { key.fill(0); return { restored: false }; }
  try {
    const current = await fingerprint(directory), planned = new Map(stage.files.map(f => [f.path, f.sha256]));
    const names = new Set([...Object.keys(current), ...Object.keys(stage.baseline), ...planned.keys()]);
    for (const name of names) {
      const before = stage.baseline[name], actual = current[name], after = planned.get(name);
      if (stage.state === 'staged' ? actual !== before : actual !== before && actual !== after) fail('The restore target changed after staging. Startup is held; no further files were replaced.', 503);
    }
    if (stage.state === 'staged') { stage.state = 'applying'; await saveStage(directory, key, stage); }
    for (const f of stage.files) {
      if (current[f.path] !== f.sha256) await write(join(directory, f.path), Buffer.from(f.base64, 'base64'));
      options.afterWrite?.(f.path);
    }
    for (const path of stage.removals) { if (await bytes(join(directory, path), MAX_PLAIN)) { await unlink(join(directory, path)); fsyncDir(dirname(join(directory, path))); } }
    const final = await fingerprint(directory);
    for (const f of stage.files) if (final[f.path] !== f.sha256) fail('Restore verification failed. Startup is held for recovery.', 503);
    await write(join(directory, PRIVATE_RESTORE_RECEIPT_FILE), Buffer.from(json({ version: 1, restoredAt: new Date().toISOString(), receipt: stage.receipt, rekeyed: true, reviewRequired: true })));
    await unlink(join(directory, PRIVATE_RESTORE_STAGE_FILE)); fsyncDir(directory);
    return { restored: true, receipt: stage.receipt };
  } finally { key.fill(0); }
}
