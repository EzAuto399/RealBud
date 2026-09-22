import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt } from 'node:crypto';
import { PRIVATE_BACKUP_MIN_PASSPHRASE, PRIVATE_BACKUP_MAX_PASSPHRASE } from '../shared/private-workspace-backup.ts';
import { PRIVATE_BACKUP_V2_VERSION, PRIVATE_BACKUP_V2_HEADER_BYTES as HEADER_BYTES,
  PRIVATE_BACKUP_V2_FRAME_HEADER_BYTES as FRAME_HEADER_BYTES, PRIVATE_BACKUP_V2_TAG_BYTES as TAG_BYTES,
  PRIVATE_BACKUP_V2_LIMITS, type PrivateBackupCodecLimits, type PrivateBackupCodecEntry,
  type PrivateBackupCodecEntryMetadata, type PrivateBackupCodecReceipt,
  type PrivateBackupCodecEncodeOptions, type PrivateBackupCodecDecodeOptions } from '../shared/private-backup-v2.ts';

// Fixed header: magic[8], version:u16, cipher:u16, N/r/p:u32 each,
// salt[16], archiveId[16], supported frame ceiling:u32, reserved zero[4].
// Each frame: role:u8, reserved zero[3], sequence:u64, length:u32,
// ciphertext[length], tag[16]. Header + frame header are authenticated data.
// Entry-end records are the streamed manifest; the footer seals its digest.
const MAGIC = Buffer.from('RBUDPV2\0', 'ascii');
const BEGIN = 1, DATA = 2, END = 3, FOOTER = 4;
const ALG = 'aes-256-gcm', N = 32768, R = 8, P = 1;
const failure = (code: string, message: string, status = 400): never => {
  throw Object.assign(new Error(message), { code, status });
};
function invalid(): never { return failure('backup_v2_invalid', 'The backup transport is malformed or incomplete.'); }
function integrity(): never { return failure('backup_v2_integrity', 'The backup passphrase or transport integrity check failed.'); }
function quota(): never { return failure('backup_v2_limit', 'The backup exceeds this operation’s supported transport limits.', 413); }
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw Object.assign(new Error('The backup operation was cancelled.'), { name: 'AbortError', code: 'backup_v2_aborted' });
}
async function abortable<T>(promise: PromiseLike<T> | T, signal?: AbortSignal): Promise<T> {
  checkAbort(signal);
  if (!signal) return await promise;
  return await new Promise<T>((resolve, reject) => {
    const aborted = () => { cleanup(); try { checkAbort(signal); } catch (error) { reject(error); } };
    const cleanup = () => signal.removeEventListener('abort', aborted);
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) aborted();
  });
}
async function nextOf<T>(iterator: AsyncIterator<T> | Iterator<T>, signal?: AbortSignal): Promise<IteratorResult<T>> {
  checkAbort(signal); return await abortable(iterator.next(), signal);
}
function limitsFor(overrides?: Partial<PrivateBackupCodecLimits>): PrivateBackupCodecLimits {
  const limits: PrivateBackupCodecLimits = { ...PRIVATE_BACKUP_V2_LIMITS };
  if (overrides !== undefined) {
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) invalid();
    for (const [key, value] of Object.entries(overrides)) {
      if (!Object.hasOwn(limits, key) || !Number.isSafeInteger(value) || value < 1 || value > PRIVATE_BACKUP_V2_LIMITS[key as keyof PrivateBackupCodecLimits]) quota();
      limits[key as keyof PrivateBackupCodecLimits] = value;
    }
  }
  return limits;
}
function validPassphrase(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length < PRIVATE_BACKUP_MIN_PASSPHRASE || value.length > PRIVATE_BACKUP_MAX_PASSPHRASE)
    failure('backup_v2_passphrase', 'Use a backup passphrase of 16–256 characters.');
}
async function keyFor(passphrase: string, salt: Buffer, signal?: AbortSignal): Promise<Buffer> {
  checkAbort(signal);
  // Scrypt cannot be interrupted. Always await its bounded work, then erase a
  // cancelled result; never abandon a derived key in a racing promise.
  const key = await new Promise<Buffer>((resolve, reject) => scrypt(passphrase, salt, 32,
    { N, r: R, p: P, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
  try { checkAbort(signal); return key; } catch (error) { key.fill(0); throw error; }
}
function header(): Buffer {
  const result = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(result); result.writeUInt16BE(PRIVATE_BACKUP_V2_VERSION, 8); result.writeUInt16BE(1, 10);
  result.writeUInt32BE(N, 12); result.writeUInt32BE(R, 16); result.writeUInt32BE(P, 20);
  randomBytes(16).copy(result, 24); randomBytes(16).copy(result, 40);
  result.writeUInt32BE(PRIVATE_BACKUP_V2_LIMITS.frameBytes, 56);
  return result;
}
function validateHeader(value: Buffer): void {
  if (value.length !== HEADER_BYTES || !value.subarray(0, 8).equals(MAGIC) || value.readUInt16BE(8) !== 2 || value.readUInt16BE(10) !== 1 ||
      value.readUInt32BE(12) !== N || value.readUInt32BE(16) !== R || value.readUInt32BE(20) !== P ||
      value.readUInt32BE(56) !== PRIVATE_BACKUP_V2_LIMITS.frameBytes || value.readUInt32BE(60) !== 0) invalid();
}
function nonce(header: Buffer, sequence: number): Buffer {
  const result = Buffer.alloc(12); header.copy(result, 0, 40, 44); result.writeBigUInt64BE(BigInt(sequence), 4); return result;
}
function frame(key: Buffer, header: Buffer, sequence: number, role: number, plain: Buffer, limits: PrivateBackupCodecLimits): Buffer {
  if (!Number.isSafeInteger(sequence) || sequence < 0 || plain.length > limits.frameBytes) quota();
  const prefix = Buffer.alloc(FRAME_HEADER_BYTES);
  prefix.writeUInt8(role); prefix.writeBigUInt64BE(BigInt(sequence), 4); prefix.writeUInt32BE(plain.length, 12);
  const cipher = createCipheriv(ALG, key, nonce(header, sequence));
  cipher.setAAD(Buffer.concat([header, prefix]));
  return Buffer.concat([prefix, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}
const bytesOf = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8');
function metadata(plain: Buffer, keys: readonly string[]): Record<string, unknown> {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(plain), value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length ||
        !keys.every(key => Object.hasOwn(value, key)) || JSON.stringify(value) !== text) invalid();
    return value as Record<string, unknown>;
  } catch { return invalid(); }
}
function nameAndSize(name: unknown, size: unknown, limits: PrivateBackupCodecLimits): asserts name is string {
  if (typeof name !== 'string' || !name ||
      !Number.isSafeInteger(size) || Number(size) < 0) invalid();
  if (name.length > limits.nameBytes || Buffer.byteLength(name, 'utf8') > limits.nameBytes || Number(size) > limits.entryBytes) quota();
  if (/[\x00-\x1f\x7f]/.test(name)) invalid();
  for (const char of name) { const cp = char.codePointAt(0)!; if (cp >= 0xd800 && cp <= 0xdfff) invalid(); }
}
function admitName(name: string, identities: Set<string>, limits: PrivateBackupCodecLimits): void {
  if (identities.size >= limits.entryCount) quota();
  const identity = createHash('sha256').update(name, 'utf8').digest('hex');
  if (identities.has(identity)) failure('backup_v2_duplicate', 'The backup contains a duplicate transport entry.');
  identities.add(identity);
}
function manifestEntry(name: string, size: number, digest: string): Buffer { return bytesOf({ name, size, digest }); }
function hashManifest(hash: ReturnType<typeof createHash>, value: Buffer): void {
  const length = Buffer.alloc(4); length.writeUInt32BE(value.length); hash.update(length).update(value);
}
function stop(iterator: AsyncIterator<unknown> | Iterator<unknown>): void {
  // Request upstream cleanup without letting a blocked producer's return()
  // prevent cancellation. File/HTTP producers also receive the same signal.
  try { void Promise.resolve(iterator.return?.()).catch(() => {}); } catch { /* preserve the original outcome */ }
}

/** Produces an encrypted transport, never reads a workspace or touches disk. */
export async function* encodePrivateBackupV2(entries: AsyncIterable<PrivateBackupCodecEntry> | Iterable<PrivateBackupCodecEntry>, options: PrivateBackupCodecEncodeOptions): AsyncGenerator<Buffer> {
  validPassphrase(options.passphrase); const limits = limitsFor(options.limits); checkAbort(options.signal);
  if (!entries || typeof entries !== 'object' ||
      !(typeof (entries as AsyncIterable<PrivateBackupCodecEntry>)[Symbol.asyncIterator] === 'function' || typeof (entries as Iterable<PrivateBackupCodecEntry>)[Symbol.iterator] === 'function')) invalid();
  const fixed = header(), key = await keyFor(options.passphrase, fixed.subarray(24, 40), options.signal);
  const archiveHash = createHash('sha256'), manifestHash = createHash('sha256'), contentHash = createHash('sha256'), identities = new Set<string>();
  let archiveBytes = 0, sequence = 0, contentBytes = 0, entryCount = 0;
  const output = (bytes: Buffer) => {
    checkAbort(options.signal);
    if (bytes.length > limits.archiveBytes - archiveBytes) quota();
    archiveBytes += bytes.length; archiveHash.update(bytes); return bytes;
  };
  let iterator: AsyncIterator<PrivateBackupCodecEntry> | Iterator<PrivateBackupCodecEntry> | undefined;
  let completed = false;
  try {
    iterator = Symbol.asyncIterator in entries ? entries[Symbol.asyncIterator]() : entries[Symbol.iterator]();
    yield output(fixed);
    while (true) {
      const next = await nextOf(iterator, options.signal); if (next.done) break;
      const entry = next.value;
      if (!entry || typeof entry !== 'object') invalid();
      nameAndSize(entry.name, entry.size, limits); admitName(entry.name, identities, limits);
      if (!entry.data || typeof entry.data[Symbol.asyncIterator] !== 'function') invalid();
      const { name, size } = entry; // Pin metadata before yielding to the caller.
      yield output(frame(key, fixed, sequence++, BEGIN, bytesOf({ name, size }), limits));
      const dataIterator = entry.data[Symbol.asyncIterator](); const digest = createHash('sha256'); let sizeRead = 0, emptyChunks = 0;
      try {
        while (true) {
          const part = await nextOf(dataIterator, options.signal); if (part.done) break;
          if (!(part.value instanceof Uint8Array)) invalid();
          if (part.value.byteLength === 0) { if (++emptyChunks > 1024) invalid(); continue; }
          emptyChunks = 0;
          if (part.value.byteLength > size - sizeRead) invalid();
          for (let offset = 0; offset < part.value.byteLength; offset += limits.frameBytes) {
            checkAbort(options.signal);
            const length = Math.min(limits.frameBytes, part.value.byteLength - offset);
            const plain = Buffer.from(part.value.buffer, part.value.byteOffset + offset, length);
            digest.update(plain); contentHash.update(plain); sizeRead += length; contentBytes += length;
            yield output(frame(key, fixed, sequence++, DATA, plain, limits));
          }
        }
      } finally { stop(dataIterator); }
      if (sizeRead !== size) invalid();
      const end = manifestEntry(name, size, digest.digest('hex')); hashManifest(manifestHash, end); entryCount++;
      yield output(frame(key, fixed, sequence++, END, end, limits));
    }
    const manifestDigest = manifestHash.digest('hex'), contentDigest = contentHash.digest('hex'), archiveId = fixed.subarray(40, 56).toString('hex');
    const footer = { version: 2, archiveId, entryCount, contentBytes, frameCount: sequence + 1, manifestDigest, contentDigest };
    yield output(frame(key, fixed, sequence++, FOOTER, bytesOf(footer), limits));
    checkAbort(options.signal);
    const receipt: PrivateBackupCodecReceipt = { ...footer, version: 2, archiveBytes, archiveDigest: archiveHash.digest('hex') };
    await abortable(options.onComplete?.(receipt), options.signal); completed = true;
  } finally { key.fill(0); identities.clear(); if (!completed && iterator) stop(iterator); }
}

class Reader {
  private iterator: AsyncIterator<Uint8Array>;
  private chunk: Uint8Array = new Uint8Array(); private offset = 0; private pulled = 0;
  private limits: PrivateBackupCodecLimits;
  private signal?: AbortSignal;
  readonly hash = createHash('sha256'); consumed = 0;
  constructor(input: AsyncIterable<Uint8Array>, limits: PrivateBackupCodecLimits, signal?: AbortSignal) {
    if (!input || typeof input[Symbol.asyncIterator] !== 'function') invalid();
    this.limits = limits; this.signal = signal;
    this.iterator = input[Symbol.asyncIterator]();
  }
  async read(length: number, eof = false): Promise<Buffer | null> {
    checkAbort(this.signal);
    if (!Number.isSafeInteger(length) || length < 1 || length > this.limits.frameBytes + TAG_BYTES + HEADER_BYTES) invalid();
    const output = Buffer.allocUnsafe(length); let written = 0, emptyChunks = 0;
    while (written < length) {
      if (this.offset === this.chunk.byteLength) {
        const next = await nextOf(this.iterator, this.signal);
        if (next.done) { if (eof && written === 0) return null; return invalid(); }
        if (!(next.value instanceof Uint8Array)) invalid();
        if (next.value.byteLength > this.limits.archiveBytes - this.pulled) quota();
        this.pulled += next.value.byteLength; this.chunk = next.value; this.offset = 0;
        if (!this.chunk.byteLength) { if (++emptyChunks > 1024) invalid(); continue; }
        emptyChunks = 0;
      }
      const count = Math.min(length - written, this.chunk.byteLength - this.offset);
      output.set(this.chunk.subarray(this.offset, this.offset + count), written);
      this.offset += count; written += count;
    }
    this.consumed += length; this.hash.update(output); return output;
  }
  close(): void { stop(this.iterator); this.chunk = new Uint8Array(); }
}

/** Visitors receive authenticated chunks, but an entry is not a trusted
 * business record. Publish nothing until this resolves and graph checks pass. */
export async function decodePrivateBackupV2(input: AsyncIterable<Uint8Array>, options: PrivateBackupCodecDecodeOptions): Promise<PrivateBackupCodecReceipt> {
  validPassphrase(options.passphrase); const limits = limitsFor(options.limits); checkAbort(options.signal);
  const reader = new Reader(input, limits, options.signal); let key: Buffer | undefined;
  const identities = new Set<string>(), manifestHash = createHash('sha256'), contentHash = createHash('sha256');
  let sequence = 0, entryCount = 0, contentBytes = 0;
  let current: { meta: PrivateBackupCodecEntryMetadata; received: number; hash: ReturnType<typeof createHash> } | undefined;
  try {
    const fixed = (await reader.read(HEADER_BYTES))!; validateHeader(fixed);
    key = await keyFor(options.passphrase, fixed.subarray(24, 40), options.signal);
    const archiveId = fixed.subarray(40, 56).toString('hex');
    while (true) {
      const prefix = (await reader.read(FRAME_HEADER_BYTES))!, role = prefix.readUInt8(0), length = prefix.readUInt32BE(12);
      if (prefix.readUIntBE(1, 3) !== 0 || prefix.readBigUInt64BE(4) !== BigInt(sequence) || ![BEGIN, DATA, END, FOOTER].includes(role) || length === 0) invalid();
      if (length > limits.frameBytes) quota();
      const encrypted = (await reader.read(length + TAG_BYTES))!;
      let plain: Buffer;
      try {
        const decipher = createDecipheriv(ALG, key, nonce(fixed, sequence));
        decipher.setAAD(Buffer.concat([fixed, prefix])); decipher.setAuthTag(encrypted.subarray(length));
        // update() output is deliberately held until final() authenticates it.
        const partial = decipher.update(encrypted.subarray(0, length));
        try { plain = Buffer.concat([partial, decipher.final()]); } finally { partial.fill(0); }
      } catch { return integrity(); }
      sequence++;
      if (role === BEGIN) {
        if (current) invalid();
        const row = metadata(plain, ['name', 'size']); nameAndSize(row.name, row.size, limits); admitName(row.name, identities, limits);
        const meta = { index: entryCount, name: row.name, size: Number(row.size) };
        current = { meta, received: 0, hash: createHash('sha256') };
        await abortable(options.visitor.begin({ ...meta }), options.signal);
      } else if (role === DATA) {
        if (!current || plain.length > current.meta.size - current.received) invalid();
        current.received += plain.length; contentBytes += plain.length; current.hash.update(plain); contentHash.update(plain);
        await abortable(options.visitor.data(plain), options.signal);
      } else if (role === END) {
        if (!current || current.received !== current.meta.size) invalid();
        const row = metadata(plain, ['name', 'size', 'digest']);
        if (row.name !== current.meta.name || row.size !== current.meta.size || row.digest !== current.hash.digest('hex')) integrity();
        hashManifest(manifestHash, manifestEntry(current.meta.name, current.meta.size, row.digest as string));
        await abortable(options.visitor.end({ ...current.meta, digest: row.digest as string }), options.signal);
        current = undefined; entryCount++;
      } else {
        if (current) invalid();
        const row = metadata(plain, ['version', 'archiveId', 'entryCount', 'contentBytes', 'frameCount', 'manifestDigest', 'contentDigest']);
        const manifestDigest = manifestHash.digest('hex'), contentDigest = contentHash.digest('hex');
        if (row.version !== 2 || row.archiveId !== archiveId || row.entryCount !== entryCount || row.contentBytes !== contentBytes ||
            row.frameCount !== sequence || row.manifestDigest !== manifestDigest || row.contentDigest !== contentDigest) integrity();
        if (await reader.read(1, true) !== null) invalid();
        checkAbort(options.signal);
        return { version: 2, archiveId, archiveBytes: reader.consumed, archiveDigest: reader.hash.digest('hex'),
          entryCount, contentBytes, frameCount: sequence, manifestDigest, contentDigest };
      }
    }
  } finally { key?.fill(0); identities.clear(); reader.close(); }
}
