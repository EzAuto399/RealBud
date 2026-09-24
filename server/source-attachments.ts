import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { SOURCE_PDF_MAX_BYTES, parseSourceAttachmentRequest, type SourceAttachmentBytes, type SourceAttachmentRequest } from '../shared/source-attachments.ts';
import { extractPdfText } from './pdf-text.ts';

const fail = (): never => { throw Object.assign(new Error('The selected PDF could not be verified or read. Review the original attachment; no contents were inferred.'), { status: 422 }); };
export const attachmentHash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Only provider-returned AWS S3 download links reach this host-owned boundary.
 * No credentials, redirects, arbitrary web origins or private DNS destinations. */
export function sourceDownloadUrl(value: unknown): URL {
  try {
    if (typeof value !== 'string' || value.length > 8192) return fail();
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash ||
      !/^(?:[a-z0-9][a-z0-9.-]*\.)?s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.test(url.hostname)) return fail();
    return url;
  } catch { return fail(); }
}
function publicIpv4(address: string): boolean {
  const a=address.split('.').map(Number);
  return a.length===4 && a.every(n=>Number.isInteger(n)&&n>=0&&n<=255) &&
    ![0,10,127].includes(a[0]!) && a[0]!<224 && !(a[0]===169&&a[1]===254) &&
    !(a[0]===172&&a[1]!>=16&&a[1]!<=31) && !(a[0]===192&&[0,168].includes(a[1]!)) &&
    !(a[0]===100&&a[1]!>=64&&a[1]!<=127) && !(a[0]===198&&[18,19].includes(a[1]!));
}
export async function downloadSourcePdf(urlValue: unknown, inputSignal: AbortSignal): Promise<Buffer> {
  const url = sourceDownloadUrl(urlValue);
  const signal = AbortSignal.any([inputSignal, AbortSignal.timeout(25_000)]);
  signal.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  let answers;
  try {
    answers = await Promise.race([
      lookup(url.hostname, { all: true, family: 4 }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Attachment DNS timed out')), 5_000);
        timer.unref();
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } catch { return fail(); }
  finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
  if (!answers.length || answers.some(a => !publicIpv4(a.address))) return fail();
  signal.throwIfAborted();
  return new Promise<Buffer>((resolve, reject) => {
    const req = request(url, {
      method: 'GET', family: 4, signal, headers: { accept: 'application/pdf' },
      // Pin the inspected address; TLS still authenticates the original S3 name.
      lookup: (_host, _options, callback) => callback(null, answers[0]!.address, 4),
    }, res => {
      const chunks: Buffer[] = [];
      let size = 0;
      const contentType = String(res.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
      if (res.statusCode !== 200 || !['application/pdf', 'application/octet-stream'].includes(contentType) ||
          Number(res.headers['content-length'] ?? 0) > SOURCE_PDF_MAX_BYTES) {
        res.destroy(); reject(new Error('Attachment response refused')); return;
      }
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > SOURCE_PDF_MAX_BYTES) { res.destroy(new Error('Attachment too large')); return; }
        chunks.push(chunk);
      });
      res.once('error', reject);
      res.once('aborted', () => reject(new Error('Attachment response interrupted')));
      res.once('end', () => resolve(Buffer.concat(chunks)));
    });
    req.once('error', reject); req.end();
  }).catch(() => fail());
}

export function validateSourceAttachmentBytes(value: unknown, expected: SourceAttachmentRequest): SourceAttachmentBytes {
  if(!value||typeof value!=='object'||Array.isArray(value))return fail();
  const v=value as Record<string,unknown>;
  if(Object.keys(v).sort().join(',')!=='accountId,attachment,bytesBase64,messageId,sha256,threadId')return fail();
  const identity=parseSourceAttachmentRequest({accountId:v.accountId,threadId:v.threadId,messageId:v.messageId,attachment:v.attachment});
  if(JSON.stringify(identity)!==JSON.stringify(parseSourceAttachmentRequest(expected)) || typeof v.bytesBase64!=='string' || v.bytesBase64.length>Math.ceil(SOURCE_PDF_MAX_BYTES/3)*4 || typeof v.sha256!=='string')return fail();
  const bytes=Buffer.from(v.bytesBase64,'base64');
  if(bytes.toString('base64')!==v.bytesBase64 || bytes.length!==identity.attachment.size || bytes.subarray(0,5).toString()!=='%PDF-' || attachmentHash(bytes)!==v.sha256)return fail();
  return {...identity,bytesBase64:v.bytesBase64,sha256:v.sha256};
}
export interface SourcePdfEvidence extends SourceAttachmentBytes { text: string; pages: number; textSha256: string }
export async function sourcePdfEvidence(value: SourceAttachmentBytes, expected: SourceAttachmentRequest, signal: AbortSignal): Promise<SourcePdfEvidence> {
  const saved=validateSourceAttachmentBytes(value,expected),parsed=await extractPdfText(Buffer.from(saved.bytesBase64,'base64'),signal);
  return {...saved,...parsed,textSha256:attachmentHash(Buffer.from(parsed.text))};
}
export function validateSourcePdfEvidence(value: SourcePdfEvidence, expected: SourceAttachmentRequest): SourcePdfEvidence {
  const {text,pages,textSha256,...source}=value;
  validateSourceAttachmentBytes(source,expected);
  if(typeof text!=='string'||!text.trim()||Buffer.byteLength(text)>64_040||!Number.isInteger(pages)||pages<1||pages>20||attachmentHash(Buffer.from(text))!==textSha256)return fail();
  return value;
}
