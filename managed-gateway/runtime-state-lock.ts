/** Shared runtime/writer leases and an exclusive offline maintenance barrier.
 * No expiry: only a proved dead owner on this host may be removed. Each owner
 * names its process incarnation (`boot`), so a lease an earlier process left
 * under this same PID (node is PID 1 in the container on every boot) is proved
 * dead, while this process's own live leases never are. SQLite clients remain
 * concurrent; maintenance waits for none. */
import { randomBytes, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fchmodSync, fsyncSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isMainThread } from 'node:worker_threads';
import { exact, object, requireThat } from './contracts.ts';

export const STATE_ID_FILE = '.realbud-gateway-state.json';
export const RESTORE_HOLD_FILE = '.realbud-gateway-restore.json';
export const RESTORE_HOLD_SETTING = 'gateway_restore_hold';
const LEASES = '.realbud-gateway-leases';
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const hex32 = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const fail = (code: string): never => { throw Object.assign(new Error(code), { status: 503 }); };
/** v1 records predate `boot`; this process only writes v2. */
type Owner = { version: 1 | 2; host: string; pid: number; boot?: string; token: string; kind: 'gate' | 'writer' | 'maintenance' };
const BOOT = Symbol.for('realbud.gateway.runtime-state-boot');
/** One random identity per process incarnation, shared by every copy of this
 * module in the process (globalThis). A worker thread shares the PID but not
 * this identity, so leases are taken on the main thread only. */
const boot = (): string => ((globalThis as unknown as Record<symbol, string | undefined>)[BOOT] ??= randomBytes(16).toString('hex'));

/** Physical spelling: the nearest existing ancestor through realpath, then the
 * not-yet-created tail. Host aliases (macOS /var -> /private/var) resolve here. */
export function physicalPath(path: string): string {
  let ancestor = resolve(path); const tail: string[] = [];
  while (!existsSync(ancestor)) {
    tail.unshift(basename(ancestor)); const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error('Output location is unavailable.');
    ancestor = parent;
  }
  return join(realpathSync(ancestor), ...tail);
}
/** `path` beneath the admitted physical `root` with no link between them: its
 * physical path is inside root and its lexical tail below root is that same
 * tail. Aliases above root are the host's. Returns the physical path. */
export function pathInsideStateRoot(path: string, root: string): string | undefined {
  if (!isAbsolute(path)) return undefined;
  const physical = physicalPath(path), lexical = resolve(path);
  if (!physical.startsWith(`${root}${sep}`)) return undefined;
  const tail = physical.slice(root.length);
  if (!lexical.endsWith(tail) || lexical.length === tail.length) return undefined;
  try { return realpathSync(lexical.slice(0, -tail.length)) === root ? physical : undefined; } catch { return undefined; }
}
const sameObject = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
/** A real folder (never a link) owned by this account, without group/other
 * access, returned by its physical path so every comparison and lease uses one
 * spelling. An owned folder whose only problem is group/other access (a Fly
 * volume root is 0755) is tightened to 0700 through a no-follow descriptor of
 * the object lstat saw, as the desktop's private storage does; a link, another
 * owner or another type stays refused. Files never self-repair. */
export function privateStateDirectory(path: string): string {
  const requested = resolve(path);
  if (!existsSync(requested)) mkdirSync(requested, { recursive: true, mode: 0o700 });
  const stat = lstatSync(requested);
  requireThat(stat.isDirectory() && !stat.isSymbolicLink() && (process.getuid === undefined || stat.uid === process.getuid()), 'gateway_state_permissions', 503);
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    const fd = openSync(requested, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_DIRECTORY ?? 0));
    try { requireThat(sameObject(stat, fstatSync(fd)), 'gateway_state_permissions', 503); fchmodSync(fd, 0o700); } finally { closeSync(fd); }
    console.warn(JSON.stringify({ gatewayState: 'tightened_to_owner_only', directory: requested }));
  }
  const root = realpathSync(requested), physical = lstatSync(root);
  requireThat(sameObject(stat, physical) && physical.isDirectory() && !physical.isSymbolicLink(), 'gateway_state_permissions', 503);
  return root;
}
function admitDescriptor(fd: number, limit: number): void {
    let stat = fstatSync(fd); const deadline = Date.now() + 100;
    // Fresh no-overwrite link publication has two names only until its private
    // temp is unlinked. Never admit a hard link; wait briefly for complete
    // publication, then preserve the strict single-link requirement.
    while (stat.nlink === 2 && Date.now() < deadline) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); stat = fstatSync(fd); }
    requireThat(stat.isFile() && stat.nlink === 1 && stat.size <= limit && (process.getuid === undefined || stat.uid === process.getuid()) &&
      (process.platform === 'win32' || (stat.mode & 0o077) === 0), 'gateway_state_file_permissions', 503);
}
export function readPrivateStateFile(path: string, limit: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    admitDescriptor(fd, limit);
    const bytes = readFileSync(fd); requireThat(bytes.length <= limit, 'gateway_state_file_too_large', 503); return bytes;
  } finally { closeSync(fd); }
}
/** Publication is complete-or-absent and durable, never an overwrite by default. */
export function publishPrivateStateFile(path: string, bytes: Buffer, replace = false): void {
  privateStateDirectory(dirname(path));
  const temporary = `${path}.${randomBytes(16).toString('hex')}.tmp`;
  let fd: number | undefined = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    writeFileSync(fd, bytes); fsyncSync(fd); closeSync(fd); fd = undefined;
    if (replace) renameSync(temporary, path);
    else {
      // rename can overwrite a concurrently created output; an exclusive final
      // descriptor plus complete bytes does not provide atomic admission. A
      // hard link publishes this fresh one-link temporary atomically instead.
      linkSync(temporary, path); unlinkSync(temporary);
    }
    if (process.platform !== 'win32') { const directory = openSync(dirname(path), constants.O_RDONLY); try { fsyncSync(directory); } finally { closeSync(directory); } }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
export function stateIdentity(root: string): { version: 1; id: string } {
  const path = join(privateStateDirectory(root), STATE_ID_FILE);
  if (!existsSync(path)) {
    try { publishPrivateStateFile(path, Buffer.from(JSON.stringify({ version: 1, id: randomUUID() }))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  const value: unknown = JSON.parse(readPrivateStateFile(path, 4096).toString()); object(value); exact(value, ['version', 'id']);
  requireThat(value.version === 1 && uuid(value.id), 'gateway_state_identity_invalid', 503);
  return value as { version: 1; id: string };
}
/** Standalone registry/secret writers must find exactly one admitted ancestor
 * root. Conflicting nested/ancestor identities hold rather than being merged.
 * Composition and export additionally require the configured ledger root. */
export function runtimeStateRoot(directory: string): string {
  let root = physicalPath(directory), selected: string | undefined;
  for (;;) {
    if (existsSync(join(root, STATE_ID_FILE))) {
      stateIdentity(root); requireThat(selected === undefined, 'gateway_state_split_root', 503); selected = root;
    }
    const parent = dirname(root); if (parent === root) break; root = parent;
  }
  return selected ?? privateStateDirectory(directory);
}
export function assertRuntimeStateActive(root: string): void {
  if (existsSync(join(root, RESTORE_HOLD_FILE))) fail('gateway_restored_state_held');
  const path = join(root, 'ledger.sqlite'); if (!existsSync(path)) return;
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { admitDescriptor(fd, Number.MAX_SAFE_INTEGER); } finally { closeSync(fd); }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=5000;');
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'").get() && db.prepare('SELECT value FROM settings WHERE key=?').get(RESTORE_HOLD_SETTING)) fail('gateway_restored_state_held');
  } finally { db.close(); }
}
function owner(path: string): Owner {
  try {
    const value: unknown = JSON.parse(readPrivateStateFile(path, 4096).toString()); object(value);
    exact(value, value.version === 2 ? ['version', 'host', 'pid', 'boot', 'token', 'kind'] : ['version', 'host', 'pid', 'token', 'kind']);
    requireThat((value.version === 1 || (value.version === 2 && hex32(value.boot))) && typeof value.host === 'string' && value.host.length <= 300 && Number.isSafeInteger(value.pid) && Number(value.pid) > 0 &&
      hex32(value.token) && ['gate', 'writer', 'maintenance'].includes(String(value.kind)), 'gateway_state_unknown_owner', 503);
    return value as Owner;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error; return fail('gateway_state_unknown_owner'); }
}
function dead(value: Owner): boolean {
  if (value.host !== hostname()) return false;
  // Live PIDs are unique on this host, so a record naming this PID is either
  // this process's own (same boot: live) or an earlier incarnation's (exited).
  if (value.pid === process.pid) return value.boot !== boot();
  try { process.kill(value.pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}
function recover(path: string): void {
  const before = owner(path); if (!dead(before)) fail('gateway_state_in_use');
  const aside = `${path}.${randomBytes(16).toString('hex')}.dead`;
  renameSync(path, aside);
  if (owner(aside).token !== before.token) {
    try { linkSync(aside, path); } finally { unlinkSync(aside); }
    fail('gateway_state_owner_changed');
  }
  unlinkSync(aside);
}
export interface RuntimeStateLease { readonly root: string; readonly stateId: string; assertCurrent(): void; release(): void }
export function acquireRuntimeStateLease(directory: string, kind: 'writer' | 'maintenance' = 'writer'): RuntimeStateLease {
  requireThat(isMainThread, 'gateway_state_worker_thread', 503);
  const root = privateStateDirectory(directory), identity = stateIdentity(root), leases = privateStateDirectory(join(root, LEASES));
  requireThat(runtimeStateRoot(root) === root, 'gateway_state_split_root', 503);
  const token = randomBytes(16).toString('hex'), record = (type: Owner['kind']) => Buffer.from(JSON.stringify({ version: 2, host: hostname(), pid: process.pid, boot: boot(), token, kind: type }));
  const gate = join(leases, 'gate');
  const deadline = Date.now() + 1_000;
  let firstAttempt = true;
  for (;;) {
    // Every retry, including vanished/dead-owner races, shares this bound.
    if (!firstAttempt && Date.now() >= deadline) fail('gateway_state_in_use');
    firstAttempt = false;
    try { publishPrivateStateFile(gate, record('gate')); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // Shared SQLite clients may join concurrently. Wait only for a brief
      // known live gate on this host, never reclaim it by time or a live boot.
      let held: Owner;
      try { held = owner(gate); } catch (readError) { if ((readError as NodeJS.ErrnoException).code === 'ENOENT') continue; throw readError; }
      if (dead(held)) { recover(gate); continue; }
      if (held.host !== hostname() || held.pid === process.pid) fail('gateway_state_in_use');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  const path = join(leases, kind === 'maintenance' ? 'maintenance' : `writer-${token}`);
  try {
    for (const name of readdirSync(leases)) {
      if (name === 'gate') continue;
      // A contender may stage a private gate publication while this gate is
      // held. The exact scratch name grants no authority and is preserved;
      // that contender still cannot publish a lease across this gate.
      if (/^gate\.[a-f0-9]{32}\.tmp$/.test(name)) continue;
      if (!/^(maintenance|writer-[a-f0-9]{32})$/.test(name)) fail('gateway_state_unknown_owner');
      const file = join(leases, name); let saved: Owner;
      try { saved = owner(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      if (dead(saved)) { recover(file); continue; }
      if (name === 'maintenance' || kind === 'maintenance') fail('gateway_state_in_use');
    }
    if (kind === 'writer') assertRuntimeStateActive(root);
    requireThat(owner(gate).token === token && stateIdentity(root).id === identity.id, 'gateway_state_owner_changed', 503);
    publishPrivateStateFile(path, record(kind));
  } finally { if (owner(gate).token === token) unlinkSync(gate); }
  let released = false;
  return { root, stateId: identity.id,
    assertCurrent() { requireThat(!released && owner(path).token === token && stateIdentity(root).id === identity.id, 'gateway_state_owner_changed', 503); },
    release() { if (released) return; requireThat(owner(path).token === token, 'gateway_state_owner_changed', 503); unlinkSync(path); released = true; },
  };
}
export function withRuntimeStateWriter<T>(directory: string, work: () => T): T {
  const lease = acquireRuntimeStateLease(runtimeStateRoot(directory));
  try { const result = work(); requireThat(!(result instanceof Promise), 'gateway_async_writer_lease_forbidden', 500); lease.assertCurrent(); return result; }
  finally { lease.release(); }
}
