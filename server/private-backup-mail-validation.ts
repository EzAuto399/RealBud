import { createHash } from 'node:crypto';
import { connectedAppCanonical, parseConnectedMailReview } from '../shared/connected-app-binding.ts';
import { CONNECTED_MAIL_OPERATIONS_FILE, validateConnectedAppOperationsSnapshot } from './connected-app-operations.ts';
import { decryptJson, isEncryptedEnvelope } from './desk-crypto.ts';
import { validateMailRecords, validateMailGraph, type MailGraphReader } from './mail-records.ts';

const PREFIX = 'company-installation/private/';
const INPUT = 'vault/workflow-inputs/accounts-inbox.json';
/** Memory-review signing keys share the private vault folder; validated by their own owner. */
export const CONNECTED_MAIL_REVIEW_PATH = /^company-installation\/private\/mail-review-([a-f0-9]{64})\.json$/;
const digest = (value: unknown) => createHash('sha256').update(connectedAppCanonical(value)).digest('hex');
const SIGNING = `${PREFIX}memory-signing.json`;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function invalid(): never { throw Object.assign(new Error('Saved mail evidence needs recovery before this backup can be used. No records were replaced.'), { status: 400 }); }
type LogicalRecord = { id: string; kind: string; revision: number; value: unknown };

export interface BackupMailFileReader {
  paths(): Iterable<string>;
  get(path: string): { encoding: 'bytes' | 'json'; data: Buffer } | undefined;
}

/** Logical v2 files have already been authenticated and re-encrypted for this
 * installation. The lazy archived view retains no source bundles and is passed
 * even when empty, so missing migration evidence can never skip comparison. */
export function validateBackupMailGraph(reader: MailGraphReader, files: BackupMailFileReader, workspaceId: string): void {
  try {
    const saved = new Map<string, unknown>();
    saved.keys = function* () {
      for (const path of files.paths()) {
        if (path === INPUT) yield 'accounts-inbox-input';
        else if (path.startsWith(PREFIX) && path !== SIGNING && !CONNECTED_MAIL_REVIEW_PATH.test(path)) {
          const name = path.slice(PREFIX.length).replace(/\.json$/, '');
          if (!/^(?:mail-workspace|mail-prepared-input|mail-scan-[a-f0-9-]{36})$/.test(name)) invalid();
          yield name;
        }
      }
    } as typeof saved.keys;
    saved.get = name => {
      const file = files.get(name === 'accounts-inbox-input' ? INPUT : `${PREFIX}${name}.json`);
      if (!file) return undefined;
      if (name === 'accounts-inbox-input') return JSON.parse(file.data.toString('utf8'));
      if (file.encoding !== 'json') invalid();
      const envelope: unknown = JSON.parse(file.data.toString('utf8'));
      if (!object(envelope) || Object.keys(envelope).sort().join(',') !== 'name,value' || envelope.name !== name) invalid();
      return envelope.value;
    };
    validateMailGraph(reader, workspaceId, saved);
  } catch { invalid(); }
}

/** Pure validation: imported encrypted bytes must form the same readable source
 * graph as a live mail workspace. No provider access or authority is inherited. */
export function validateBackupMail(files: { path: string; base64: string }[], key: Buffer, workspaceId: string, records: LogicalRecord[] = []): void {
  try {
    const saved = new Map<string, unknown>();
    for (const file of files) {
      if (file.path === INPUT) {
        if (saved.has('accounts-inbox-input')) invalid();
        saved.set('accounts-inbox-input', JSON.parse(Buffer.from(file.base64, 'base64').toString('utf8')));
        continue;
      }
      if (!file.path.startsWith(PREFIX) || file.path === SIGNING || CONNECTED_MAIL_REVIEW_PATH.test(file.path)) continue;
      const name = file.path.slice(PREFIX.length).replace(/\.json$/, '');
      if (!/^(?:mail-workspace|mail-prepared-input|mail-scan-[a-f0-9-]{36})$/.test(name) || saved.has(name)) invalid();
      const raw = Buffer.from(file.base64, 'base64');
      // Match the live private-vault reader, including its encrypted-byte cap.
      if (raw.length > 2_000_000) invalid();
      const encrypted: unknown = JSON.parse(raw.toString('utf8'));
      if (!isEncryptedEnvelope(encrypted)) invalid();
      const envelope = decryptJson(key, encrypted);
      if (!object(envelope) || Object.keys(envelope).sort().join(',') !== 'name,value' || envelope.name !== name) invalid();
      saved.set(name, envelope.value);
    }
    // One authoritative pure graph contract is shared by migration, live reads
    // and portable restore. Legacy files can remain inert beside normalized
    // records, but their committed origin and historical evidence must agree.
    validateMailRecords(records, saved, workspaceId);
  } catch { invalid(); }
}

/** Receipt identities and exact encrypted original reviews travel together.
 * These artifacts are host-only, with no generic private-vault namespace grant. */
export function validateBackupConnectedMail(files: BackupMailFileReader, workspaceId: string): void {
  try {
    const expectedWorkspace = createHash('sha256').update(workspaceId).digest('hex');
    const history = files.get(CONNECTED_MAIL_OPERATIONS_FILE);
    const rows = history ? validateConnectedAppOperationsSnapshot(JSON.parse(history.data.toString('utf8'))).operations : [];
    const reviews = new Map<string, ReturnType<typeof parseConnectedMailReview>>();
    for (const path of files.paths()) {
      const match = CONNECTED_MAIL_REVIEW_PATH.exec(path); if (!match) continue;
      const file = files.get(path); if (!file || file.encoding !== 'json' || file.data.length > 2_000_000) invalid();
      const envelope = JSON.parse(file.data.toString('utf8'));
      if (!object(envelope) || Object.keys(envelope).sort().join(',') !== 'name,value' || envelope.name !== `mail-review-${match[1]}`) invalid();
      const review = parseConnectedMailReview(envelope.value, digest);
      if (review.reviewDigest !== match[1] || review.workspaceDigest !== expectedWorkspace || reviews.has(match[1])) invalid();
      reviews.set(match[1], review);
    }
    for (const row of rows) {
      // Legacy unidentified rows remain conservative held history. No fabricated
      // account/effect/artifact identity is assigned during migration or restore.
      if (!row.reviewDigest) continue;
      const review = reviews.get(row.reviewDigest);
      if (!review || row.workspaceDigest !== expectedWorkspace || review.workspaceDigest !== row.workspaceDigest || review.accountDigest !== row.accountDigest || review.bindingDigest !== row.bindingDigest || !row.realmDigest || digest({ companyId: review.binding.companyId, gatewayOrigin: review.gatewayOrigin }) !== row.realmDigest) invalid();
    }
  } catch { invalid(); }
}
/** v1 archives carry encrypted raw files; validate the same logical graph. */
export function validateBackupConnectedMailBytes(files: { path: string; base64: string }[], key: Buffer, workspaceId: string): void {
  const map = new Map(files.map(file => [file.path, file]));
  validateBackupConnectedMail({ paths: () => map.keys(), get(path) {
    const file = map.get(path); if (!file) return undefined;
    const raw = Buffer.from(file.base64, 'base64');
    if (!CONNECTED_MAIL_REVIEW_PATH.test(path)) return { encoding: 'bytes', data: raw };
    if (raw.length > 2_000_000) invalid();
    let value; try { value = decryptJson(key, JSON.parse(raw.toString('utf8'))); } catch { invalid(); }
    return { encoding: 'json', data: Buffer.from(JSON.stringify(value)) };
  } }, workspaceId);
}
