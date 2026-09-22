Bounded implementation proposal. Own ONLY NEW server/private-backup-v2-api.ts and server/private-backup-v2-api.test.ts. You are not alone: Codex implements the coordinator/index wiring; another Grok proposal owns prepared storage. No tools or external actions. Return JSON {summary,patch,risks}. Do not edit supplied shared/client files.

Implement a pure strict host boundary mirroring existing v1 API but preserving the EXISTING v2 client route/request contract below. No networking/filesystem, source bodies/keys, HTTP auth bypass, path construction or actual service implementation. Export BackupV2ApiService interface and createPrivateBackupV2Api(host:{service:()=>BackupV2ApiService}). Returned function accepts {path:string,method:string,query?:URLSearchParams,body?:unknown,bytes?:Uint8Array,chunkDigest?:unknown} and returns null outside /api/private-backup/v2, otherwise Promise<{status:number,body:unknown}|{status:200,downloadTicket:string}>. Download branch only validates token/GET; actual token consumption and streaming are host/coordinator-owned. Session protection supplied by HTTP host and must apply before this function. No request path or query can choose disk directories/keys/workspaces. Caller limits raw request reads before allocating body. Internal errors must never leak via body; this API can throw safe fixed status errors for malformed input or invalid service projections; root HTTP maps other service exceptions.

Service methods (root will implement exact interface):
 list(input:{limit:number,cursor?:string}):Promise<PrivateBackupTransferPage>;
 get(id:string):Promise<PrivateBackupTransferOperation>;
 startExport(id:string,passphrase:string):Promise<Operation>;
 startUpload(id:string,totalBytes:number):Promise<Operation>;
 appendUpload(id:string,offset:number,bytes:Uint8Array,sha256:string):Promise<Operation>;
 sealUpload(id:string,totalBytes:number,chunkCommitment:string):Promise<Operation>;
 preview(id:string,passphrase:string,expectedArchiveDigest:string):Promise<Operation>;
 stage(id:string,expectedArchiveDigest:string):Promise<Operation>;
 cancel(id:string):Promise<Operation>;
 downloadTicket(id:string,expectedArchiveDigest:string):Promise<PrivateBackupDownloadTicket>.

GET /operations?limit&cursor ->200 page. Limit1..20 default20; cursor base64url1..512. Reject duplicate/unknown query fields.
POST /exports {id,passphrase} ->202 {operation}
GET /operations/:id ->200 {operation}
POST /operations/:id/download-ticket {expectedArchiveDigest} ->200 ticket
POST /uploads {id,totalBytes} ->201 {operation}
PUT /uploads/:id/chunks?offset=N raw <=1MiB bytes + x-realbud-chunk-sha256 exposed as chunkDigest ->200 {operation}; offset safe decimalinteger>=0 aligned1MiB, nonemptychunk; id UUID, digestlowerhex64. No JSON body; no extra queryfields.
POST /uploads/:id/seal {totalBytes,chunkCommitment} ->200 {operation}
POST /uploads/:id/preview {passphrase,expectedArchiveDigest} ->202 {operation}
POST /uploads/:id/stage {expectedArchiveDigest,confirm:true} ->202 {operation}; reject missing/wrong confirm before service access.
POST /operations/:id/cancel no body or emptyobject ->200 {operation}
GET /downloads/<32..128base64url> ->{status:200,downloadTicket:token}. Unknown method/routes404. Other routes reject any queryparams. Reject extra fields, malformed objects, arbitrary paths/workspace/key fields. Passphrase length16..256 as existing client/codec. totalBytes1..1GiB. Do not treat chunkCommitment as archive digest; bothhexbutsemanticnamedunchanged.

Validate every service-produced public projection with the existing shared parsers before returning. Do not forward internal records or strip unknown private fields into a success silently. Operation id/kind must match route intent. GET operation/cancel/downloadticket maytargeteitherkind asdomainenforces; uploads endpoints mustreturnupload, exportsreturnexport. Data must not expose path/allocations/keys/businesspayload. Filename/url parsed bysharedticketparser. Pure boundary tests should protect important rejection/forwarding/foreign-id/invalid output conditions and prove service notcalled for malformedinput; no shallow implementation-mirroring dozensofcases.

### shared/private-backup-transfers.ts
import { parsePrivateBackupReceipt, type PrivateBackupReceipt } from './private-workspace-backup.ts';

/** Public transport projections only. Never include scratch paths, keys,
 * passphrases, raw exceptions, or uploaded business values here. */
export const PRIVATE_BACKUP_TRANSFER_CHUNK_BYTES = 1024 * 1024;
export const PRIVATE_BACKUP_TRANSFER_MAX_BYTES = 1024 * 1024 * 1024;
export const PRIVATE_BACKUP_TRANSFER_MAX_ITEMS = 20;
export const PRIVATE_BACKUP_TRANSFER_API = '/api/private-backup/v2';
export const PRIVATE_BACKUP_TRANSFER_PHASES = [
  'capturing', 'sealing', 'ready', 'uploading', 'uploaded', 'checking', 'reviewed',
  'staging', 'staged', 'applying', 'completed', 'interrupted', 'failed', 'cancelled', 'expired',
] as const;
export type PrivateBackupTransferPhase = typeof PRIVATE_BACKUP_TRANSFER_PHASES[number];
export const PRIVATE_BACKUP_TRANSFER_ERRORS = {
  interrupted: 'This backup operation was interrupted. Check its saved progress before continuing.',
  'invalid-backup': 'This file could not be verified as a complete supported backup. Keep the original file.',
  'incorrect-passphrase': 'The backup could not be opened with that passphrase. Check it and try again.',
  'storage-unavailable': 'Backup storage is unavailable. Keep the original file and check this computer.',
  'insufficient-space': 'This computer needs more free space before the backup can continue.',
  'workspace-busy': 'Finish the current work before continuing this backup operation.',
  'restore-unavailable': 'This workspace is not ready to restore this backup.',
  'recovery-required': 'This backup operation needs recovery. Keep its files and contact support.',
  expired: 'This saved transfer has expired. Keep the original backup file.',
} as const;
export type PrivateBackupTransferErrorCode = keyof typeof PRIVATE_BACKUP_TRANSFER_ERRORS;
export interface PrivateBackupTransferArtifact { archiveBytes: number; archiveDigest: string }
export interface PrivateBackupTransferOperation {
  version: 2; id: string; workspaceId: string; kind: 'export' | 'upload';
  phase: PrivateBackupTransferPhase; createdAt: number; updatedAt: number; expiresAt: number | null;
  progress: { completedBytes: number; totalBytes: number | null };
  canCancel: boolean; requiresPassphrase: boolean;
  /** Required for upload operations, including interrupted/closed ones. */
  receivedBytes?: number; prefixCommitment?: string;
  artifact?: PrivateBackupTransferArtifact;
  /** Published only after complete authentication AND business graph validation. */
  preview?: PrivateBackupReceipt;
  error?: { code: PrivateBackupTransferErrorCode };
}
export interface PrivateBackupTransferPage {
  version: 2; workspaceId: string;
  limits: { archiveBytes: number; chunkBytes: typeof PRIVATE_BACKUP_TRANSFER_CHUNK_BYTES };
  items: PrivateBackupTransferOperation[]; total: number; nextCursor: string | null;
}
export interface PrivateBackupDownloadTicket extends PrivateBackupTransferArtifact {
  url: string; filename: string; expiresAt: number;
}
/** SHA-256 of UTF-8 JSON.stringify(tuples), in this exact order, with lowercase
 * digests. At most 1024 tuples; this is NOT the whole-file archive digest. */
export type PrivateBackupChunkTuple = [offset: number, size: number, sha256: string];

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, required: string[], optional: string[] = []) => required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const integer = (v: unknown, min = 0): v is number => Number.isSafeInteger(v) && Number(v) >= min;
export const privateBackupTransferId = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
export const privateBackupTransferDigest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function artifact(v: unknown): PrivateBackupTransferArtifact | null {
  return object(v) && keys(v, ['archiveBytes', 'archiveDigest']) && integer(v.archiveBytes, 1) && v.archiveBytes <= PRIVATE_BACKUP_TRANSFER_MAX_BYTES && privateBackupTransferDigest(v.archiveDigest)
    ? { archiveBytes: v.archiveBytes, archiveDigest: v.archiveDigest } : null;
}
function receipt(v: unknown): PrivateBackupReceipt | null {
  if (!object(v) || !keys(v, ['digest', 'createdAt', 'workspaceId', 'fileCount', 'recordCount', 'plainBytes', 'included', 'excluded', 'restoreChanges'])) return null;
  const parsed = parsePrivateBackupReceipt(v);
  if (!parsed || parsed.createdAt.length > 40) return null;
  // Human-readable category labels, not filenames, evidence bodies, or errors.
  if ([parsed.included, parsed.excluded, parsed.restoreChanges].some(list => list.length > 20 || list.some(s => !s.trim() || new TextEncoder().encode(s).length > 300 || /[\u0000-\u001f\u007f]/.test(s)))) return null;
  return parsed;
}
export function parsePrivateBackupTransferOperation(v: unknown): PrivateBackupTransferOperation | null {
  if (!object(v) || !keys(v, ['version', 'id', 'workspaceId', 'kind', 'phase', 'createdAt', 'updatedAt', 'expiresAt', 'progress', 'canCancel', 'requiresPassphrase'], ['receivedBytes', 'prefixCommitment', 'artifact', 'preview', 'error']) ||
      v.version !== 2 || !privateBackupTransferId(v.id) || !privateBackupTransferId(v.workspaceId) || typeof v.kind !== 'string' || !['export', 'upload'].includes(v.kind) ||
      !PRIVATE_BACKUP_TRANSFER_PHASES.includes(v.phase as PrivateBackupTransferPhase) || !integer(v.createdAt, 1) || !integer(v.updatedAt, v.createdAt) ||
      !(v.expiresAt === null || integer(v.expiresAt, v.createdAt)) || typeof v.canCancel !== 'boolean' || typeof v.requiresPassphrase !== 'boolean' ||
      !object(v.progress) || !keys(v.progress, ['completedBytes', 'totalBytes']) || !integer(v.progress.completedBytes) ||
      !(v.progress.totalBytes === null || integer(v.progress.totalBytes, v.progress.completedBytes))) return null;
  const phase = v.phase as PrivateBackupTransferPhase;
  if (['staging', 'staged', 'applying', 'completed', 'cancelled', 'expired'].includes(phase) && v.canCancel) return null;
  if (v.requiresPassphrase && !['interrupted', 'failed', 'uploaded'].includes(phase)) return null;
  if (v.kind === 'upload') {
    const size = v.progress.totalBytes;
    if (!integer(size, 1) || size > PRIVATE_BACKUP_TRANSFER_MAX_BYTES || !integer(v.receivedBytes) || v.receivedBytes > size ||
        v.receivedBytes !== size && v.receivedBytes % PRIVATE_BACKUP_TRANSFER_CHUNK_BYTES !== 0 || !privateBackupTransferDigest(v.prefixCommitment) ||
        ['capturing', 'ready'].includes(phase)) return null;
    if (['uploaded', 'checking', 'reviewed', 'staging', 'staged', 'applying', 'completed'].includes(phase) && v.receivedBytes !== size) return null;
    if (v.requiresPassphrase && v.receivedBytes !== size) return null;
  } else if (Object.hasOwn(v, 'receivedBytes') || Object.hasOwn(v, 'prefixCommitment') || ['uploading', 'uploaded', 'checking', 'reviewed', 'staging', 'staged', 'applying'].includes(phase)) return null;
  const parsedArtifact = v.artifact === undefined ? undefined : artifact(v.artifact);
  if (parsedArtifact === null || parsedArtifact && v.kind === 'upload' && parsedArtifact.archiveBytes !== v.progress.totalBytes) return null;
  if (parsedArtifact && ['capturing', 'uploading', 'cancelled', 'expired'].includes(phase)) return null;
  if (['ready', 'uploaded', 'checking', 'reviewed', 'staging', 'staged', 'applying', 'completed'].includes(phase) && !parsedArtifact) return null;
  const parsedPreview = v.preview === undefined ? undefined : receipt(v.preview);
  if (parsedPreview === null || parsedPreview && (!parsedArtifact || !['ready', 'reviewed', 'staging', 'staged', 'applying', 'completed'].includes(phase))) return null;
  if (parsedPreview && parsedPreview.digest !== parsedArtifact?.archiveDigest) return null;
  if (['reviewed', 'staging', 'staged', 'applying'].includes(phase) && !parsedPreview) return null;
  if (v.error !== undefined && (!object(v.error) || !keys(v.error, ['code']) || typeof v.error.code !== 'string' || !Object.hasOwn(PRIVATE_BACKUP_TRANSFER_ERRORS, v.error.code))) return null;
  return {
    version: 2, id: v.id, workspaceId: v.workspaceId, kind: v.kind as 'export' | 'upload', phase,
    createdAt: v.createdAt, updatedAt: v.updatedAt, expiresAt: v.expiresAt as number | null,
    progress: { completedBytes: v.progress.completedBytes, totalBytes: v.progress.totalBytes as number | null },
    canCancel: v.canCancel, requiresPassphrase: v.requiresPassphrase,
    ...(v.kind === 'upload' ? { receivedBytes: v.receivedBytes as number, prefixCommitment: v.prefixCommitment as string } : {}),
    ...(parsedArtifact ? { artifact: parsedArtifact } : {}), ...(parsedPreview ? { preview: parsedPreview } : {}),
    ...(v.error ? { error: { code: (v.error as { code: PrivateBackupTransferErrorCode }).code } } : {}),
  };
}
export function parsePrivateBackupTransferResponse(v: unknown): PrivateBackupTransferOperation | null {
  return object(v) && keys(v, ['operation']) ? parsePrivateBackupTransferOperation(v.operation) : null;
}
export function parsePrivateBackupTransferPage(v: unknown): PrivateBackupTransferPage | null {
  if (!object(v) || !keys(v, ['version', 'workspaceId', 'limits', 'items', 'total', 'nextCursor']) || v.version !== 2 || !privateBackupTransferId(v.workspaceId) ||
      !object(v.limits) || !keys(v.limits, ['archiveBytes', 'chunkBytes']) || !integer(v.limits.archiveBytes, 1) || v.limits.archiveBytes > PRIVATE_BACKUP_TRANSFER_MAX_BYTES || v.limits.chunkBytes !== PRIVATE_BACKUP_TRANSFER_CHUNK_BYTES ||
      !Array.isArray(v.items) || v.items.length > PRIVATE_BACKUP_TRANSFER_MAX_ITEMS || !integer(v.total, v.items.length) ||
      !(v.nextCursor === null || typeof v.nextCursor === 'string' && /^[a-zA-Z0-9_-]{1,512}$/.test(v.nextCursor))) return null;
  const items = v.items.map(parsePrivateBackupTransferOperation);
  if (items.some(item => !item || item.workspaceId !== v.workspaceId) || new Set(items.map(item => item?.id)).size !== items.length) return null;
  return { version: 2, workspaceId: v.workspaceId, limits: { archiveBytes: v.limits.archiveBytes, chunkBytes: PRIVATE_BACKUP_TRANSFER_CHUNK_BYTES }, items: items as PrivateBackupTransferOperation[], total: v.total, nextCursor: v.nextCursor as string | null };
}
export function parsePrivateBackupDownloadTicket(v: unknown): PrivateBackupDownloadTicket | null {
  if (!object(v) || !keys(v, ['url', 'filename', 'expiresAt', 'archiveBytes', 'archiveDigest']) || typeof v.url !== 'string' ||
      !/^\/api\/private-backup\/v2\/downloads\/[A-Za-z0-9_-]{32,128}$/.test(v.url) || typeof v.filename !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}\.realbud-backup$/.test(v.filename) || !integer(v.expiresAt, 1)) return null;
  const a = artifact({ archiveBytes: v.archiveBytes, archiveDigest: v.archiveDigest });
  return a ? { ...a, url: v.url, filename: v.filename, expiresAt: v.expiresAt } : null;
}

### server/private-backup-api.ts
import type { createPrivateWorkspaceBackup } from './private-workspace-backup.ts';
type Service=ReturnType<typeof createPrivateWorkspaceBackup>;
export interface PrivateBackupApiHost {
  service:()=>Service;
  restoreReadiness:()=>{canRestore:boolean;reason:string;bootstrap:boolean};
  beginRestore:()=>void;
  restoreFailed:()=>Promise<void>;
  snapshotActive?:()=>boolean;
}
const fail=(message:string,status=400):never=>{throw Object.assign(new Error(message),{status});};
function fields(body:unknown,allowed:string[]){
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!allowed.includes(k)))return fail('Use the supported private-backup fields.');
  return body as Record<string,unknown>;
}
/** Session protection is supplied by the HTTP host. No password or unsealed
 * business data is included in the returned preview or written to logs. */
export function createPrivateBackupApi(host:PrivateBackupApiHost){
  return async(path:string,method:string,body?:unknown)=>{
    if(!/^\/api\/private-backup(?:\/|$)/.test(path))return null;
    if(path==='/api/private-backup'&&method==='GET'){
      const status=await host.service().status();
      return {status:200,body:{...host.restoreReadiness(),staged:status.state!=='none',receipt:status.receipt,completed:status.completed??null,...(host.snapshotActive?{snapshotActive:host.snapshotActive()}:{}),...(status.completionWarning?{completionWarning:status.completionWarning}:{})}};
    }
    if(path==='/api/private-backup/export'&&method==='POST'){
      const b=fields(body,['passphrase']);
      const result=await host.service().exportBackup(b.passphrase as string);
      return {status:200,body:{...result,filename:`RealBud-private-work-${new Date().toISOString().slice(0,10)}.realbud-backup`}};
    }
    if(path==='/api/private-backup/preview'&&method==='POST'){
      const b=fields(body,['backup','passphrase']);
      return {status:200,body:await host.service().previewBackup(b.backup,b.passphrase as string)};
    }
    if(path==='/api/private-backup/restore'&&method==='POST'){
      const b=fields(body,['backup','passphrase','expectedDigest','confirm']);
      if(b.confirm!==true)return fail('Confirm restoring this reviewed backup into the empty workspace.');
      const readiness=host.restoreReadiness();
      if(!readiness.canRestore||!readiness.bootstrap)return fail(readiness.reason||'Use a fresh supported desktop to restore this backup.',409);
      host.beginRestore();
      try{return {status:200,body:await host.service().stageRestore({backup:b.backup,passphrase:b.passphrase as string,expectedDigest:b.expectedDigest as string})};}
      catch(error){await host.restoreFailed();throw error;}
    }
    return {status:404,body:{error:'Unknown private-backup action.'}};
  };
}
