import { afterEach, describe, expect, it } from 'vitest';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { resolveDeskKey } from './desk-key-custody.mjs';
import { privateFixtureRoot, profileAclWitness, WINDOWS_PROFILE_TEST_OPTIONS } from '../server/testing/private-profile-fixture.ts';

// Real production selector; only OS safeStorage is replaced by an AES fixture.
const directories = [];
afterEach(() => { for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function envelope(key, value) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return JSON.stringify({ v: 1, alg: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') });
}
function safeStorageFixture() {
  const wrappingKey = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString: text => Buffer.from(envelope(wrappingKey, text)),
    decryptString: bytes => {
      const v = JSON.parse(bytes.toString()), decipher = createDecipheriv('aes-256-gcm', wrappingKey, Buffer.from(v.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(v.tag, 'base64'));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(v.ct, 'base64')), decipher.final()]).toString());
    },
  };
}
function fixture() {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'realbud-key-custody-')); directories.push(dir);
  const safeStorage = safeStorageFixture();
  return { dir, safeStorage, resolve: options => resolveDeskKey({ directory: dir, safeStorage, ...options }) };
}
/** Stands in for the win32 ACL helper on every OS so the wiring is provable. */
function recorder() {
  const calls = [];
  return { calls, privacy: (target, kind, restrict = false) => { calls.push([target, kind, restrict]); } };
}
describe('desktop encryption key custody with a mocked safeStorage boundary', () => {
  it('migrates a valid raw key to a protected file and preserves it across repeated starts', () => {
    const f = fixture(), key = randomBytes(32), raw = path.join(f.dir, 'desk.key');
    fs.writeFileSync(raw, key, { mode: 0o600 }); fs.writeFileSync(path.join(f.dir, 'desk.json'), envelope(key, { fictional: true }));
    expect(f.resolve().hex === key.toString('hex')).toBe(true);
    expect(fs.existsSync(raw)).toBe(false);
    expect(f.resolve().hex === key.toString('hex')).toBe(true);
  });
  it('does not replace the live book key with a stale raw key that only opens an older quarantine', () => {
    const f = fixture(), live = randomBytes(32), stale = randomBytes(32);
    fs.writeFileSync(path.join(f.dir, 'desk.key'), stale, { mode: 0o600 });
    fs.writeFileSync(path.join(f.dir, 'desk.key.wrap'), f.safeStorage.encryptString(live.toString('hex')), { mode: 0o600 });
    fs.writeFileSync(path.join(f.dir, 'desk.json'), envelope(live, { fictional: 'current office' }));
    const quarantine = path.join(f.dir, 'desk.json.quarantine-2026-09-01');
    fs.writeFileSync(quarantine, envelope(stale, { fictional: 'old sample' }));
    const original = fs.readFileSync(quarantine);
    expect(f.resolve().hex === live.toString('hex')).toBe(true);
    expect(fs.readFileSync(path.join(f.dir, 'desk.key')).equals(stale)).toBe(true);
    expect(fs.readFileSync(quarantine)).toEqual(original);
  });
  it('retains the old wrapped key when a reviewed raw key opens the current book', () => {
    const f = fixture(), live = randomBytes(32), old = randomBytes(32);
    const oldWrap = f.safeStorage.encryptString(old.toString('hex'));
    fs.writeFileSync(path.join(f.dir, 'desk.key'), live, { mode: 0o600 });
    fs.writeFileSync(path.join(f.dir, 'desk.key.wrap'), oldWrap, { mode: 0o600 });
    fs.writeFileSync(path.join(f.dir, 'desk.json'), envelope(live, { fictional: 'current' }));
    expect(f.resolve().hex === live.toString('hex')).toBe(true);
    const held = fs.readdirSync(f.dir).find(name => name.startsWith('desk.key.wrap.recovery-'));
    expect(held).toBeTruthy(); expect(fs.readFileSync(path.join(f.dir, held))).toEqual(oldWrap);
    expect(f.resolve().hex === live.toString('hex')).toBe(true);
  });
  it.each(['workflow-state.sqlite', 'private-workspace-restore.json', 'company-installation/private/saved-mail.json', 'desk.json.quarantine-fixture'])('refuses a new key when the desk is missing but %s exists', name => {
    const f = fixture(), file = path.join(f.dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'fictional encrypted state');
    expect(() => f.resolve()).toThrow(/needs recovery/);
    expect(fs.readFileSync(file, 'utf8')).toBe('fictional encrypted state');
    expect(fs.existsSync(path.join(f.dir, 'desk.key.wrap'))).toBe(false);
  });
  it.each([true, false])('holds unreadable protected custody with encryption available=%s', available => {
    const f = fixture(), wrap = path.join(f.dir, 'desk.key.wrap'), original = Buffer.from('unreadable protected fixture');
    fs.writeFileSync(wrap, original, { mode: 0o600 }); f.safeStorage.isEncryptionAvailable = () => available;
    expect(() => f.resolve()).toThrow(/needs recovery/);
    expect(fs.readFileSync(wrap)).toEqual(original); expect(fs.existsSync(path.join(f.dir, 'desk.key'))).toBe(false);
  });
  it('does not guess between different keys when only workflow state remains', () => {
    const f = fixture(); fs.writeFileSync(path.join(f.dir, 'desk.key'), randomBytes(32), { mode: 0o600 });
    fs.writeFileSync(path.join(f.dir, 'desk.key.wrap'), f.safeStorage.encryptString(randomBytes(32).toString('hex')), { mode: 0o600 });
    fs.writeFileSync(path.join(f.dir, 'workflow-state.sqlite'), 'fixture');
    expect(() => f.resolve()).toThrow(/needs recovery/);
  });
  it('uses an existing raw key without changing it while safeStorage is unavailable', () => {
    const f = fixture(), key = randomBytes(32), raw = path.join(f.dir, 'desk.key');
    fs.writeFileSync(raw, key, { mode: 0o600 }); f.safeStorage.isEncryptionAvailable = () => false;
    const result = f.resolve(); expect(result.hex === key.toString('hex')).toBe(true); expect(result.production).toBe(false);
    expect(fs.readFileSync(raw)).toEqual(key); expect(fs.existsSync(path.join(f.dir, 'desk.key.wrap'))).toBe(false);
  });
  it('retains unreadable wrap evidence when a raw key proves current-book access', () => {
    const f = fixture(), key = randomBytes(32), bytes = Buffer.from('unreadable wrap');
    fs.writeFileSync(path.join(f.dir, 'desk.key'), key, { mode: 0o600 }); fs.writeFileSync(path.join(f.dir, 'desk.key.wrap'), bytes, { mode: 0o600 });
    fs.writeFileSync(path.join(f.dir, 'desk.json'), envelope(key, { fictional: true }));
    expect(f.resolve().hex === key.toString('hex')).toBe(true);
    const held = fs.readdirSync(f.dir).find(name => name.startsWith('desk.key.wrap.recovery-'));
    expect(fs.readFileSync(path.join(f.dir, held))).toEqual(bytes);
  });
  it('never removes raw custody when protected storage fails to persist', () => {
    const f = fixture(), key = randomBytes(32), raw = path.join(f.dir, 'desk.key');
    fs.writeFileSync(raw, key, { mode: 0o600 }); f.safeStorage.encryptString = () => { throw new Error('Fixture keychain locked'); };
    expect(() => f.resolve()).toThrow(/locked/); expect(fs.readFileSync(raw)).toEqual(key);
  });
  it('retains a raw key replaced by a concurrent recovery write while wrapping', () => {
    const f = fixture(), key = randomBytes(32), recovered = randomBytes(32), raw = path.join(f.dir, 'desk.key');
    fs.writeFileSync(raw, key, { mode: 0o600 });
    const encrypt = f.safeStorage.encryptString;
    f.safeStorage.encryptString = text => { fs.writeFileSync(raw, recovered); return encrypt(text); };
    expect(f.resolve().hex === key.toString('hex')).toBe(true);
    expect(fs.readFileSync(raw)).toEqual(recovered);
  });
  it('creates a protected key once for a new workspace without writing plaintext', () => {
    const f = fixture(), first = f.resolve();
    expect(first.production).toBe(true); expect(f.resolve().hex === first.hex).toBe(true);
    expect(fs.existsSync(path.join(f.dir, 'desk.key'))).toBe(false);
  });
  it.skipIf(process.platform === 'win32')('rejects publicly readable key files without rewriting them', () => {
    const f = fixture(), raw = path.join(f.dir, 'desk.key'), key = randomBytes(32);
    fs.writeFileSync(raw, key, { mode: 0o644 });
    expect(() => f.resolve()).toThrow(/needs recovery/); expect(fs.readFileSync(raw)).toEqual(key);
  });
});

// Windows mode bits are not an ACL, so on win32 the mode/uid admission above is
// replaced by the same ACL policy server/private-json.ts applies. The helper is
// injected here so the wiring is proven on every OS; only the native suite
// below proves the descriptor an actual Windows account ends up with.
describe('Windows ACL policy for the key directory and key files', () => {
  it('keeps the embedded ACL script byte-identical to the canonical server helper', () => {
    const script = name => {
      const source = fs.readFileSync(new URL(name, import.meta.url), 'utf8');
      const found = source.match(/const WINDOWS_ACL = `([\s\S]*?)`;/);
      expect(found, `no WINDOWS_ACL template in ${name}`).toBeTruthy();
      return found[1];
    };
    expect(script('./desk-key-custody.mjs')).toBe(script('../server/windows-file-privacy.ts'));
  });

  it('restricts a newly created key directory and the wrapped key before key material is written', () => {
    const f = fixture(), first = recorder(), directory = path.join(f.dir, 'workspace');
    const created = resolveDeskKey({ directory, safeStorage: f.safeStorage, windowsFilePrivacy: first.privacy });
    expect(created.production).toBe(true);
    expect(first.calls[0]).toEqual([directory, 'directory', true]);
    const restricted = first.calls.filter(([, kind, restrict]) => kind === 'file' && restrict);
    expect(restricted).toHaveLength(1);
    // The wrap is restricted on its temp name; a protected DACL survives rename.
    expect(restricted[0][0].startsWith(`${path.join(directory, 'desk.key.wrap')}.`)).toBe(true);

    const again = recorder();
    resolveDeskKey({ directory, safeStorage: f.safeStorage, windowsFilePrivacy: again.privacy });
    // An existing directory is left alone — an install predating this policy
    // must still open its key — but its key file is verified before it is read.
    expect(again.calls.some(([, kind]) => kind === 'directory')).toBe(false);
    expect(again.calls).toContainEqual([path.join(directory, 'desk.key.wrap'), 'file', false]);
  });

  it('publishes the wrap by a same-directory rename and verifies the published name', () => {
    const f = fixture(), r = recorder(), directory = path.join(f.dir, 'workspace');
    resolveDeskKey({ directory, safeStorage: f.safeStorage, windowsFilePrivacy: r.privacy });
    const files = r.calls.filter(([, kind]) => kind === 'file');
    expect(files).toHaveLength(2);
    // The temp is a sibling of the destination, so the rename stays on one
    // volume and cannot inherit the destination directory's ACEs.
    expect(files[0][2]).toBe(true);
    expect(path.dirname(files[0][0])).toBe(directory);
    expect(files[1]).toEqual([path.join(directory, 'desk.key.wrap'), 'file', false]);
  });

  it('refuses the key when the published wrap fails its post-rename verify, and mints nothing', () => {
    const f = fixture(), directory = path.join(f.dir, 'workspace');
    const wrapPath = path.join(directory, 'desk.key.wrap');
    const failPublished = (target, kind, restrict = false) => {
      if (target === wrapPath && !restrict) throw new Error('Windows privacy for the saved workspace encryption key needs recovery.');
    };
    expect(() => resolveDeskKey({ directory, safeStorage: f.safeStorage, windowsFilePrivacy: failPublished })).toThrow(/needs recovery/);
    // The caller got no key. A later start adopts the wrap already on disk
    // rather than minting a second identity over the same workspace.
    const published = f.safeStorage.decryptString(fs.readFileSync(wrapPath));
    const recovered = resolveDeskKey({ directory, safeStorage: f.safeStorage, windowsFilePrivacy: recorder().privacy });
    expect(recovered.hex).toBe(published);
  });

  it('restricts and then verifies a preserved recovery copy', () => {
    const f = fixture(), r = recorder(), live = randomBytes(32), old = randomBytes(32);
    fs.writeFileSync(path.join(f.dir, 'desk.key'), live, { mode: 0o600 });
    fs.writeFileSync(path.join(f.dir, 'desk.key.wrap'), f.safeStorage.encryptString(old.toString('hex')), { mode: 0o600 });
    fs.writeFileSync(path.join(f.dir, 'desk.json'), envelope(live, { fictional: 'current' }));
    expect(resolveDeskKey({ directory: f.dir, safeStorage: f.safeStorage, windowsFilePrivacy: r.privacy }).hex).toBe(live.toString('hex'));
    const held = fs.readdirSync(f.dir).find(name => name.startsWith('desk.key.wrap.recovery-'));
    expect(r.calls).toContainEqual([path.join(f.dir, held), 'file', true]);
    expect(r.calls).toContainEqual([path.join(f.dir, held), 'file', false]);
  });

  it('opens an existing key under a directory this policy never protected', () => {
    const f = fixture(), r = recorder(), key = randomBytes(32);
    // f.dir is mkdtemp'd, exactly like an application root from an older build.
    fs.writeFileSync(path.join(f.dir, 'desk.key'), key, { mode: 0o600 });
    fs.writeFileSync(path.join(f.dir, 'desk.json'), envelope(key, { fictional: true }));
    expect(resolveDeskKey({ directory: f.dir, safeStorage: f.safeStorage, windowsFilePrivacy: r.privacy }).hex).toBe(key.toString('hex'));
    expect(r.calls.some(([, kind]) => kind === 'directory')).toBe(false);
  });

  it('verifies both existing key files before reading them', () => {
    const f = fixture(), r = recorder(), key = randomBytes(32);
    fs.writeFileSync(path.join(f.dir, 'desk.key'), key, { mode: 0o600 });
    fs.writeFileSync(path.join(f.dir, 'desk.key.wrap'), f.safeStorage.encryptString(key.toString('hex')), { mode: 0o600 });
    fs.writeFileSync(path.join(f.dir, 'desk.json'), envelope(key, { fictional: true }));
    expect(resolveDeskKey({ directory: f.dir, safeStorage: f.safeStorage, windowsFilePrivacy: r.privacy }).hex).toBe(key.toString('hex'));
    expect(r.calls).toContainEqual([path.join(f.dir, 'desk.key'), 'file', false]);
    expect(r.calls).toContainEqual([path.join(f.dir, 'desk.key.wrap'), 'file', false]);
  });

  it('refuses to mint a key when the directory cannot be made private', () => {
    const f = fixture(), directory = path.join(f.dir, 'workspace');
    const privacy = () => { throw new Error('Windows privacy for the saved workspace encryption key needs recovery.'); };
    expect(() => resolveDeskKey({ directory, safeStorage: f.safeStorage, windowsFilePrivacy: privacy })).toThrow(/needs recovery/);
    expect(fs.existsSync(path.join(directory, 'desk.key.wrap'))).toBe(false);
    expect(fs.existsSync(path.join(directory, 'desk.key'))).toBe(false);
  });
});

// Native descriptors only: this runs on the Windows CI runner, never here.
describe.runIf(process.platform === 'win32')('native Windows key-file privacy', () => {
  it('protects the key directory and the wrapped key it writes', WINDOWS_PROFILE_TEST_OPTIONS, () => {
    const root = privateFixtureRoot(path.join(tmpdir(), 'realbud-key-custody-acl-'));
    directories.push(root);
    const directory = path.join(root, 'workspace'), safeStorage = safeStorageFixture();
    const result = resolveDeskKey({ directory, safeStorage });
    expect(result.production).toBe(true);
    const observed = profileAclWitness([directory, path.join(directory, 'desk.key.wrap')]);
    expect(observed).toHaveLength(2);
    for (const witness of observed) {
      expect(witness.protected).toBe(true);
      expect(witness.currentOwner).toBe(true);
      expect(witness.onlyPrivateGrants).toBe(true);
      expect(witness.currentFullControl).toBe(true);
      expect(witness.hasDeny).toBe(false);
    }
    // A second start must still admit its own descriptors without repairing them.
    expect(resolveDeskKey({ directory, safeStorage }).hex).toBe(result.hex);
  });
});
