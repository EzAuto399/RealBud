import { createCipheriv, createDecipheriv, scryptSync } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { encodePrivateBackupV2, decodePrivateBackupV2 } from './private-backup-codec.ts';
import { PRIVATE_BACKUP_V2_LIMITS, type PrivateBackupCodecEntry, type PrivateBackupCodecReceipt,
  type PrivateBackupCodecDecodeOptions } from '../shared/private-backup-v2.ts';

const passphrase = 'Fictional codec test passphrase 2026';
const limits = { frameBytes: 512 };
async function* input(bytes: Uint8Array, step = bytes.byteLength || 1) {
  for (let offset = 0; offset < bytes.byteLength; offset += step) yield bytes.subarray(offset, offset + step);
}
function entry(name: string, bytes: Uint8Array): PrivateBackupCodecEntry { return { name, size: bytes.byteLength, data: input(bytes, 173) }; }
async function collect(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks);
}
const visitor = () => ({ begin: vi.fn(), data: vi.fn(), end: vi.fn() });
const decode = (bytes: Uint8Array, options: Partial<PrivateBackupCodecDecodeOptions> = {}) =>
  decodePrivateBackupV2(input(bytes), { passphrase, visitor: visitor(), ...options });
function frames(bytes: Buffer): Buffer[] {
  const rows: Buffer[] = []; let offset = 64;
  while (offset < bytes.length) { const size = 32 + bytes.readUInt32BE(offset + 12); rows.push(bytes.subarray(offset, offset + size)); offset += size; }
  return rows;
}
function changedFrame(bytes: Buffer, index: number, transform: (plain: Buffer) => Buffer): Buffer {
  const rows = frames(bytes), fixed = bytes.subarray(0, 64), old = rows[index];
  const key = scryptSync(passphrase, fixed.subarray(24, 40), 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  try {
    const nonce = Buffer.alloc(12); fixed.copy(nonce, 0, 40, 44); old.copy(nonce, 4, 4, 12);
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(Buffer.concat([fixed, old.subarray(0, 16)])); decipher.setAuthTag(old.subarray(-16));
    const plain = transform(Buffer.concat([decipher.update(old.subarray(16, -16)), decipher.final()]));
    const prefix = Buffer.from(old.subarray(0, 16)); prefix.writeUInt32BE(plain.length, 12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(Buffer.concat([fixed, prefix]));
    rows[index] = Buffer.concat([prefix, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    return Buffer.concat([fixed, ...rows]);
  } finally { key.fill(0); }
}

let archive: Buffer, other: Buffer, encodedReceipt: PrivateBackupCodecReceipt;
const original = Buffer.concat([Buffer.from('\ufeffReference,Name\r\n"12,3",私人\r\n', 'utf8'), Buffer.alloc(1200, 0xa7)]);
beforeAll(async () => {
  const entries = () => [entry('logical:fictional-私人', original), entry('empty', Buffer.alloc(0))];
  archive = await collect(encodePrivateBackupV2(entries(), { passphrase, limits, onComplete: receipt => { encodedReceipt = receipt; } }));
  other = await collect(encodePrivateBackupV2(entries(), { passphrase, limits }));
});

describe('private backup v2 authenticated transport', () => {
  it('roundtrips exact bytes and empty entries, keeping names encrypted and receipts identical', async () => {
    const entries: { name: string; size: number; chunks: Buffer[] }[] = [];
    const received = await decode(archive, { visitor: {
      begin: meta => { entries.push({ ...meta, chunks: [] }); },
      data: bytes => { entries.at(-1)!.chunks.push(Buffer.from(bytes)); },
      end: meta => { expect(meta.digest).toMatch(/^[a-f0-9]{64}$/); },
    } });
    expect(received).toEqual(encodedReceipt);
    expect(entries.map(row => row.name)).toEqual(['logical:fictional-私人', 'empty']);
    expect(Buffer.concat(entries[0].chunks)).toEqual(original); expect(entries[1].chunks).toEqual([]);
    expect(archive.includes(Buffer.from('logical:fictional-私人'))).toBe(false);
    expect(archive.includes(Buffer.from(passphrase))).toBe(false); expect(archive.equals(other)).toBe(false);
  });

  it.each([1, 2, 3, 7, 15, 16, 17, 31, 63, 64, 65, 127, 511, 512, 513])('handles all byte boundaries with transport chunks of %i bytes', async step => {
    expect(await decodePrivateBackupV2(input(archive, step), { passphrase, visitor: visitor() })).toEqual(encodedReceipt);
  });

  it('authenticates an empty archive', async () => {
    const bytes = await collect(encodePrivateBackupV2([], { passphrase }));
    expect(await decode(bytes)).toMatchObject({ entryCount: 0, contentBytes: 0, frameCount: 1 });
  });

  it('does not release any entry plaintext for the wrong passphrase', async () => {
    const callbacks = visitor(); await expect(decode(archive, { passphrase: 'A different fictional passphrase', visitor: callbacks })).rejects.toMatchObject({ code: 'backup_v2_integrity' });
    expect(callbacks.begin).not.toHaveBeenCalled(); expect(callbacks.data).not.toHaveBeenCalled();
  });

  it('authenticates a complete data frame before its visitor sees any bytes', async () => {
    const parts = frames(archive).map(row => Buffer.from(row)), index = parts.findIndex(row => row[0] === 2);
    parts[index][parts[index].length - 1] ^= 1;
    const callbacks = visitor();
    await expect(decode(Buffer.concat([archive.subarray(0, 64), ...parts]), { visitor: callbacks })).rejects.toMatchObject({ code: 'backup_v2_integrity' });
    expect(callbacks.begin).toHaveBeenCalledTimes(1); expect(callbacks.data).not.toHaveBeenCalled();
  });

  it.each(['header', 'frame prefix', 'ciphertext', 'tag', 'footer'])('rejects truncation within %s', async point => {
    const first = frames(archive)[0];
    const cut = point === 'header' ? 63 : point === 'frame prefix' ? 70 : point === 'ciphertext' ? 82 : point === 'tag' ? 64 + first.length - 1 : archive.length - 1;
    await expect(decode(archive.subarray(0, cut))).rejects.toMatchObject({ code: 'backup_v2_invalid' });
  });

  it.each(['duplicate', 'reorder', 'splice', 'trailing', 'missing footer'])('rejects %s frames or bytes', async attack => {
    const rows = [...frames(archive)];
    if (attack === 'duplicate') rows.splice(1, 0, rows[0]);
    if (attack === 'reorder') [rows[0], rows[1]] = [rows[1], rows[0]];
    if (attack === 'splice') rows[1] = frames(other)[1];
    if (attack === 'trailing') rows.push(Buffer.from([1]));
    if (attack === 'missing footer') rows.pop();
    await expect(decode(Buffer.concat([archive.subarray(0, 64), ...rows]))).rejects.toThrow(/transport|integrity/);
  });

  it.each([8, 10, 12, 16, 20, 56, 60])('rejects an unsupported clear header field at %i before visiting', async offset => {
    const changed = Buffer.from(archive); changed[offset] ^= 0x80;
    const callbacks = visitor(); await expect(decode(changed, { visitor: callbacks })).rejects.toMatchObject({ code: 'backup_v2_invalid' });
    expect(callbacks.begin).not.toHaveBeenCalled();
  });

  it.each(['length', 'sequence', 'reserved', 'role'])('rejects invalid frame %s without allocating the claimed length', async field => {
    const changed = Buffer.from(archive);
    if (field === 'length') changed.writeUInt32BE(0xffffffff, 76);
    if (field === 'sequence') changed.writeBigUInt64BE(0xffffffffffffffffn, 68);
    if (field === 'reserved') changed[65] = 1;
    if (field === 'role') changed[64] = 0xff;
    await expect(decode(changed)).rejects.toMatchObject({ code: field === 'length' ? 'backup_v2_limit' : 'backup_v2_invalid' });
  });

  it.each(['entryCount', 'contentBytes', 'frameCount', 'manifestDigest', 'contentDigest', 'archiveId'])('rejects an authenticated but false footer %s', async field => {
    const changed = changedFrame(archive, frames(archive).length - 1, plain => {
      const row = JSON.parse(plain.toString()); row[field] = typeof row[field] === 'number' ? row[field] + 1 : 'f'.repeat(row[field].length); return Buffer.from(JSON.stringify(row));
    });
    await expect(decode(changed)).rejects.toMatchObject({ code: 'backup_v2_integrity' });
  });

  it.each(['wrong size', 'noncanonical duplicate keys', 'noninteger size', 'negative size', 'oversized size'])('rejects authenticated begin metadata with %s', async attack => {
    const changed = changedFrame(archive, 0, plain => {
      const row = JSON.parse(plain.toString());
      if (attack === 'noncanonical duplicate keys') return Buffer.from(`{"name":"shadow",${plain.toString().slice(1)}`);
      row.size = attack === 'wrong size' ? row.size - 1 : attack === 'noninteger size' ? 1.5 : attack === 'negative size' ? -1 : Number.MAX_SAFE_INTEGER;
      return Buffer.from(JSON.stringify(row));
    });
    await expect(decode(changed)).rejects.toThrow(/transport/);
  });

  it('rejects authenticated duplicate entry names before the second visitor', async () => {
    const rows = frames(archive), index = rows.findLastIndex(row => row[0] === 1), callbacks = visitor();
    const changed = changedFrame(archive, index, plain => { const row = JSON.parse(plain.toString()); row.name = 'logical:fictional-私人'; return Buffer.from(JSON.stringify(row)); });
    await expect(decode(changed, { visitor: callbacks })).rejects.toMatchObject({ code: 'backup_v2_duplicate' });
    expect(callbacks.begin).toHaveBeenCalledTimes(1);
  });

  it('rejects authenticated data changes against the entry digest', async () => {
    const index = frames(archive).findIndex(row => row[0] === 2);
    const changed = changedFrame(archive, index, plain => { plain[0] ^= 1; return plain; });
    await expect(decode(changed)).rejects.toMatchObject({ code: 'backup_v2_integrity' });
  });

  it.each(['duplicate', 'short', 'long', 'bad name', 'bad size'])('refuses invalid encoder input: %s', async failure => {
    let entries = [entry('one', Buffer.from('abc'))];
    if (failure === 'duplicate') entries.push(entry('one', Buffer.from('different')));
    if (failure === 'short') entries[0].size = 4;
    if (failure === 'long') entries[0].size = 2;
    if (failure === 'bad name') entries[0].name = '\ud800';
    if (failure === 'bad size') entries[0].size = NaN;
    const done = vi.fn(); await expect(collect(encodePrivateBackupV2(entries, { passphrase, onComplete: done }))).rejects.toThrow();
    expect(done).not.toHaveBeenCalled();
  });

  it.each(['archiveBytes', 'entryBytes', 'entryCount', 'frameBytes', 'nameBytes'] as const)('enforces the configured lower %s quota during decode', async key => {
    const value = key === 'archiveBytes' ? archive.length - 1 : key === 'entryCount' ? 1 : key === 'frameBytes' ? 32 : 2;
    await expect(decode(archive, { limits: { [key]: value } })).rejects.toMatchObject({ code: 'backup_v2_limit' });
  });

  it.each([0, -1, NaN, Infinity, 1.5, PRIVATE_BACKUP_V2_LIMITS.archiveBytes + 1])('rejects invalid or increased limits: %s', async archiveBytes => {
    await expect(decode(archive, { limits: { archiveBytes } })).rejects.toMatchObject({ code: 'backup_v2_limit' });
  });

  it('honors backpressure at both entry production and asynchronous visitor consumption', async () => {
    let produced = 0;
    async function* data() { produced++; yield Buffer.from('abc'); produced++; yield Buffer.from('def'); }
    const encoded = encodePrivateBackupV2([{ name: 'one', size: 6, data: data() }], { passphrase });
    await encoded.next(); await encoded.next(); expect(produced).toBe(0);
    await encoded.next(); expect(produced).toBe(1); await encoded.return(undefined); expect(produced).toBe(1);
    let pulled = 0, release!: () => void, arrived!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), reached = new Promise<void>(resolve => { arrived = resolve; });
    async function* source() { yield archive.subarray(0, 64); for (const row of frames(archive)) { pulled++; yield row; } }
    const decoding = decodePrivateBackupV2(source(), { passphrase, visitor: { begin() {}, end() {}, async data() { arrived(); await held; } } });
    await reached; const before = pulled; await new Promise(resolve => setTimeout(resolve, 10)); expect(pulled).toBe(before);
    release(); await expect(decoding).resolves.toEqual(encodedReceipt);
  });

  it('aborts a blocked input and requests its cleanup without waiting for more bytes', async () => {
    const abort = new AbortController(), returned = vi.fn();
    const source: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}), return: () => { returned(); return Promise.resolve({ done: true, value: undefined }); } }) };
    const work = decodePrivateBackupV2(source, { passphrase, signal: abort.signal, visitor: visitor() });
    abort.abort(); await expect(work).rejects.toMatchObject({ name: 'AbortError' }); expect(returned).toHaveBeenCalled();
  });

  it('aborts a blocked encoder producer without completing its receipt', async () => {
    const abort = new AbortController(), done = vi.fn(), returned = vi.fn();
    const data: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}), return: () => { returned(); return Promise.resolve({ done: true, value: undefined }); } }) };
    const stream = encodePrivateBackupV2([{ name: 'one', size: 3, data }], { passphrase, signal: abort.signal, onComplete: done });
    await stream.next(); await stream.next(); const pending = stream.next(); abort.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' }); expect(done).not.toHaveBeenCalled(); expect(returned).toHaveBeenCalled();
  });

  it('does not return a receipt when a visitor fails or a stream stops before its footer', async () => {
    await expect(decode(archive, { visitor: { begin() {}, end() {}, data() { throw new Error('fictional sink failure'); } } })).rejects.toThrow('fictional sink failure');
    const done = vi.fn(), stream = encodePrivateBackupV2([entry('one', original)], { passphrase, onComplete: done });
    await stream.next(); await stream.return(undefined); expect(done).not.toHaveBeenCalled();
  });

  it('bounds empty-chunk work without accepting an empty or incomplete transport', async () => {
    async function* empty() { while (true) yield new Uint8Array(); }
    await expect(decodePrivateBackupV2(empty(), { passphrase, visitor: visitor() })).rejects.toMatchObject({ code: 'backup_v2_invalid' });
    await expect(collect(encodePrivateBackupV2([{ name: 'empty', size: 0, data: empty() }], { passphrase }))).rejects.toMatchObject({ code: 'backup_v2_invalid' });
  });

  it('streams more than 96 MiB with a bounded retained working set in a separate native Node process', async () => {
    const moduleUrl = new URL('./private-backup-codec.ts', import.meta.url).href;
    const script = `import {encodePrivateBackupV2,decodePrivateBackupV2} from ${JSON.stringify(moduleUrl)}; import {isDeepStrictEqual} from 'node:util';
      global.gc(); const baseline=process.memoryUsage(); let peakArrayBuffers=baseline.arrayBuffers,peakRss=baseline.rss,bytes=0,calls=0;
      async function* entries(){ for(let i=0;i<17;i++){ yield {name:'fictional-'+i,size:6*1024*1024,data:(async function*(){for(let n=0;n<96;n++)yield Buffer.alloc(65536,i);})()}; } }
      let written; const passphrase='Fictional large stream passphrase';
      const receipt=await decodePrivateBackupV2(encodePrivateBackupV2(entries(),{passphrase,onComplete:r=>{written=r;}}),{passphrase,visitor:{begin(){},end(){},data(chunk){
        bytes+=chunk.length; calls++; const usage=process.memoryUsage(); peakArrayBuffers=Math.max(peakArrayBuffers,usage.arrayBuffers); peakRss=Math.max(peakRss,usage.rss);
        if(calls%32===0)global.gc();
      }}}); global.gc();
      process.stdout.write(JSON.stringify({bytes,archiveBytes:receipt.archiveBytes,entryCount:receipt.entryCount,matching:isDeepStrictEqual(receipt,written),
        peakArrayBufferDelta:peakArrayBuffers-baseline.arrayBuffers,retainedArrayBufferDelta:process.memoryUsage().arrayBuffers-baseline.arrayBuffers,peakRssDelta:peakRss-baseline.rss}));`;
    const { stdout } = await promisify(execFile)(process.execPath, ['--expose-gc', '--experimental-strip-types', '--input-type=module', '-e', script], { maxBuffer: 64 * 1024, timeout: 30_000 });
    const measured = JSON.parse(stdout);
    expect(measured).toMatchObject({ bytes: 102 * 1024 * 1024, entryCount: 17, matching: true });
    expect(measured.archiveBytes).toBeGreaterThan(96 * 1024 * 1024);
    expect(measured.peakArrayBufferDelta).toBeLessThan(48 * 1024 * 1024);
    expect(measured.retainedArrayBufferDelta).toBeLessThan(8 * 1024 * 1024);
    console.info('backup v2 codec bounded-stream measurement', measured);
  }, 35_000);
});
