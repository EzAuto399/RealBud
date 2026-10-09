/** Shared runtime/writer leases and an exclusive offline maintenance barrier.
 * No expiry or same-PID reclamation: only a proved dead owner on this host may
 * be removed. SQLite clients remain concurrent; maintenance waits for none. */
import { randomBytes, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fsyncSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { exact, object, requireThat } from './contracts.ts';

export const STATE_ID_FILE = '.realbud-gateway-state.json';
export const RESTORE_HOLD_FILE = '.realbud-gateway-restore.json';
export const RESTORE_HOLD_SETTING = 'gateway_restore_hold';
const LEASES = '.realbud-gateway-leases';
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const fail = (code: string): never => { throw Object.assign(new Error(code), { status: 503 }); };
type Owner = { version: 1; host: string; pid: number; token: string; kind: 'gate' | 'writer' | 'maintenance' };

export function privateStateDirectory(path: string): string {
  const root = resolve(path);
  if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = lstatSync(root);
  requireThat(stat.isDirectory() && !stat.isSymbolicLink() && realpathSync(root) === root &&
    (process.getuid === undefined || stat.uid === process.getuid()) && (process.platform === 'win32' || (stat.mode & 0o077) === 0), 'gateway_state_permissions', 503);
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
  let root = resolve(directory), selected: string | undefined;
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
    const value: unknown = JSON.parse(readPrivateStateFile(path, 4096).toString()); object(value); exact(value, ['version', 'host', 'pid', 'token', 'kind']);
    requireThat(value.version === 1 && typeof value.host === 'string' && value.host.length <= 300 && Number.isSafeInteger(value.pid) && Number(value.pid) > 0 &&
      typeof value.token === 'string' && /^[a-f0-9]{32}$/.test(value.token) && ['gate', 'writer', 'maintenance'].includes(String(value.kind)), 'gateway_state_unknown_owner', 503);
    return value as Owner;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error; return fail('gateway_state_unknown_owner'); }
}
function dead(value: Owner): boolean {
  if (value.host !== hostname() || value.pid === process.pid) return false;
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
  const root = privateStateDirectory(directory), identity = stateIdentity(root), leases = privateStateDirectory(join(root, LEASES));
  requireThat(runtimeStateRoot(root) === root, 'gateway_state_split_root', 503);
  const token = randomBytes(16).toString('hex'), record = (type: Owner['kind']) => Buffer.from(JSON.stringify({ version: 1, host: hostname(), pid: process.pid, token, kind: type }));
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
      // known live gate on this host, never reclaim it by time or same PID.
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
