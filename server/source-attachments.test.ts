import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { attachmentHash, downloadSourcePdf, sourceDownloadUrl, validateSourceAttachmentBytes } from './source-attachments.ts';
import { parseSourceAttachmentRequest, SOURCE_PDF_MAX_BYTES } from '../shared/source-attachments.ts';
import { fictionalPdf } from './testing/pdf-fixture.ts';
vi.mock('node:dns/promises',()=>({lookup:vi.fn()}));
vi.mock('node:https',()=>({request:vi.fn()}));
afterEach(()=>{vi.resetAllMocks();vi.useRealTimers();});
const bytes=fictionalPdf();
const source={accountId:'fictional-account',messageId:'abc',threadId:'def',attachment:{id:'pdf-a',name:'fictional.pdf',mimeType:'application/pdf' as const,size:bytes.length}};
const envelope=()=>({...source,bytesBase64:bytes.toString('base64'),sha256:attachmentHash(bytes)});
describe('source PDF identity and bytes',()=>{
  it('accepts one exact saved source with canonical original bytes',()=>{
    expect(validateSourceAttachmentBytes(envelope(),source)).toEqual(envelope());
  });
  it.each([
    {accountId:'other'}, {messageId:'aaa'}, {sha256:'0'.repeat(64)}, {extra:'field'},
    {bytesBase64:bytes.toString('base64')+'\n'}, {attachment:{...source.attachment,size:bytes.length+1}},
  ])('rejects mismatched, tampered or ambiguous bytes: %j',change=>expect(()=>validateSourceAttachmentBytes({...envelope(),...change},source)).toThrow());
  it.each([
    {...source,url:'https://example.invalid'}, {...source,attachment:{...source.attachment,name:'../invoice.pdf'}},
    {...source,attachment:{...source.attachment,size:SOURCE_PDF_MAX_BYTES+1}},
    {...source,attachment:{...source.attachment,id:'inline-2'}},
    {...source,attachment:{...source.attachment,mimeType:'text/html'}},
  ])('rejects unsupported source scope before acquisition: %j',input=>expect(()=>parseSourceAttachmentRequest(input)).toThrow());
});
describe('provider attachment download boundary',()=>{
  const url='https://fictional-bucket.s3.ap-southeast-2.amazonaws.com/fictional.pdf?signature=fictional';
  it.each(['http://fictional.s3.amazonaws.com/file','https://s3.amazonaws.com.evil.invalid/file','https://localhost/file','https://127.0.0.1/file','https://user:pass@s3.amazonaws.com/file','https://s3.amazonaws.com:444/file'])('refuses non-provider or credential-bearing URL %s',input=>expect(()=>sourceDownloadUrl(input)).toThrow());
  it('preserves a provider signature without forwarding any account credentials',async()=>{
    vi.mocked(lookup).mockResolvedValue([{address:'52.95.0.1',family:4}] as never);
    vi.mocked(request).mockImplementation(((u:any,options:any,callback:any)=>{
      expect(u.href).toBe(url);expect(options.family).toBe(4);expect(options.headers).toEqual({accept:'application/pdf'});
      options.lookup(u.hostname,{},(_error:unknown,address:string,family:number)=>{expect(address).toBe('52.95.0.1');expect(family).toBe(4);});
      const req=new EventEmitter() as any;
      req.end=()=>{const res=Readable.from([bytes]) as any;res.statusCode=200;res.headers={'content-type':'application/pdf','content-length':String(bytes.length)};callback(res);};return req;
    }) as any);
    expect(await downloadSourcePdf(url,new AbortController().signal)).toEqual(bytes);
  });
  it.each(['127.0.0.1','10.0.0.1','169.254.169.254','172.16.0.1','192.168.1.1','100.64.0.1'])('refuses private DNS destination %s before HTTPS',async address=>{
    vi.mocked(lookup).mockResolvedValue([{address,family:4}] as never);
    await expect(downloadSourcePdf(url,new AbortController().signal)).rejects.toThrow();expect(request).not.toHaveBeenCalled();
  });
  it.each(['redirect','wrong-type','oversized-header','oversized-stream'])('refuses %s without exposing its URL',async kind=>{
    vi.mocked(lookup).mockResolvedValue([{address:'52.95.0.1',family:4}] as never);
    vi.mocked(request).mockImplementation(((_u:any,_o:any,callback:any)=>{
      const req=new EventEmitter() as any;
      req.end=()=>{const res=Readable.from([kind==='oversized-stream'?Buffer.alloc(SOURCE_PDF_MAX_BYTES+1):bytes]) as any;res.statusCode=kind==='redirect'?302:200;res.headers={'content-type':kind==='wrong-type'?'text/html':'application/pdf',...(kind==='oversized-header'?{'content-length':String(SOURCE_PDF_MAX_BYTES+1)}:{})};callback(res);};return req;
    }) as any);
    await expect(downloadSourcePdf(url,new AbortController().signal)).rejects.toThrow(/selected PDF/);
  });
  it('aborts unresolved DNS promptly and never starts HTTPS',async()=>{
    vi.mocked(lookup).mockReturnValue(new Promise(()=>{}) as never);
    const controller=new AbortController(),pending=downloadSourcePdf(url,controller.signal);controller.abort();
    await expect(pending).rejects.toThrow();expect(request).not.toHaveBeenCalled();
  });
});
