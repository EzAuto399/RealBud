import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { SOURCE_PDF_MAX_BYTES } from '../shared/source-attachments.ts';
import { redactSecretsInText } from './redact.ts';

export interface PdfText { text: string; pages: number }
const failed = (message = 'This PDF could not be read completely. Review the original; no contents were inferred.') => Object.assign(new Error(message), { status: 422 });
export function extractPdfText(bytes: Uint8Array, signal?: AbortSignal): Promise<PdfText> {
  if (!bytes.length || bytes.length > SOURCE_PDF_MAX_BYTES || Buffer.from(bytes.subarray(0,5)).toString() !== '%PDF-') return Promise.reject(failed());
  const worker = fileURLToPath(new URL('./helpers/pdf-text-worker.mjs',import.meta.url));
  const reads = [dirname(worker)];
  // Source development resolves the pinned dependency; packaged worker is one
  // self-contained bundle and needs only its helper folder.
  if (worker.endsWith('/server/helpers/pdf-text-worker.mjs') || worker.endsWith('\\server\\helpers\\pdf-text-worker.mjs')) {
    try {
      reads.push(dirname(dirname(fileURLToPath(import.meta.resolve('unpdf/pdfjs')))));
      reads.push(fileURLToPath(new URL('../node_modules/unpdf', import.meta.url)));
      reads.push(fileURLToPath(new URL('../package.json', import.meta.url)));
    } catch { /* packaged bundle */ }
  }
  return new Promise((resolve,reject) => {
    const child=execFile(process.execPath,['--permission',...reads.map(path=>`--allow-fs-read=${path}`),'--max-old-space-size=96',worker],
      {env:{ELECTRON_RUN_AS_NODE:'1'},timeout:5_000,killSignal:'SIGKILL',maxBuffer:70_000,encoding:'utf8',...(signal?{signal}:{})},(error,stdout)=>{
        if(error)return reject(failed(signal?.aborted?'PDF reading was stopped. No contents were accepted.':undefined));
        try {
          const result=JSON.parse(stdout);
          if(typeof result.text!=='string'||!result.text.trim()||Buffer.byteLength(result.text)>64_040||!Number.isSafeInteger(result.pages)||result.pages<1||result.pages>20)throw Error();
          resolve({text:redactSecretsInText(result.text),pages:result.pages});
        } catch {reject(failed());}
      });
    child.stdin?.on('error',()=>{});
    child.stdin?.end(bytes);
  });
}
