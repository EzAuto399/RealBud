/** Host-selected source identity, never a worker-supplied URL or local path. */
export const SOURCE_PDF_MAX_BYTES = 2_000_000;
export interface SourceAttachmentRequest {
  accountId: string; threadId: string; messageId: string;
  attachment: { id: string; name: string; mimeType: 'application/pdf'; size: number };
}
export interface SourceAttachmentBytes extends SourceAttachmentRequest { bytesBase64: string; sha256: string }
const invalid = (): never => { throw Object.assign(new Error('Choose one saved PDF attachment within 2 MB from the reviewed mail source.'), { status: 400 }); };
const exact = (v: unknown, keys: string[]): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v,k))) return invalid();
  return v as Record<string, unknown>;
};
export function parseSourceAttachmentRequest(value: unknown): SourceAttachmentRequest {
  const v = exact(value,['accountId','threadId','messageId','attachment']);
  if (typeof v.accountId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(v.accountId) ||
      typeof v.threadId !== 'string' || !/^[a-fA-F0-9]{1,128}$/.test(v.threadId) ||
      typeof v.messageId !== 'string' || !/^[a-fA-F0-9]{1,128}$/.test(v.messageId)) return invalid();
  const a = exact(v.attachment,['id','name','mimeType','size']);
  if (typeof a.id !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(a.id) || a.id.startsWith('inline-') ||
      typeof a.name !== 'string' || a.name.length > 255 || !/\.pdf$/i.test(a.name) || /[\\/\x00-\x1f\x7f]/.test(a.name) ||
      a.mimeType !== 'application/pdf' || !Number.isSafeInteger(a.size) || Number(a.size) < 1 || Number(a.size) > SOURCE_PDF_MAX_BYTES) return invalid();
  return { accountId:v.accountId,threadId:v.threadId,messageId:v.messageId,attachment:{id:a.id,name:a.name,mimeType:'application/pdf',size:Number(a.size)} };
}
