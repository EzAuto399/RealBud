// The repair decision around the Windows ACL helper, with that helper injected.
// What each category means on a real descriptor is proven only on Windows
// (windows-private-admission-windows.test.ts); here, which refusals lead to a
// repair, which never do, and what the log keeps.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { windowsFilePrivacyBatch, windowsFilePrivacyBatchSync, type WindowsFilePrivacyOperation } from './windows-file-privacy.ts';
import { admitPrivateObject, admitPrivateObjects, admitPrivateObjectsSync } from './windows-private-admission.ts';
import { admitPrivateDirectorySync, readPrivateJson, writePrivateJson } from './private-json.ts';
import { writeNewPrivateFile } from './private-file.ts';
import { windowsFilePrivacy } from './windows-file-privacy.ts';
import { setOpLogPath } from './oplog.ts';

vi.mock('./windows-file-privacy.ts', () => ({
  windowsFilePrivacy: vi.fn(async () => {}),
  windowsFilePrivacyBatch: vi.fn(async (operations: WindowsFilePrivacyOperation[]) => operations.map(o => ({ ...o, applied: true }))),
  windowsFilePrivacyBatchSync: vi.fn((operations: WindowsFilePrivacyOperation[]) => operations.map(o => ({ ...o, applied: true }))),
}));

/** The shape windows-file-privacy.ts throws: a fixed, path-free message. */
const refusal = (category: string, operationIndex: number | null = null) => Object.assign(
  new Error(`Windows file privacy could not be verified. Use a private directory owned by the trusted installer account. [windows-acl:${category}; exit=5]`),
  { name: 'WindowsFilePrivacyError', category, operationIndex },
);
const batch = vi.mocked(windowsFilePrivacyBatch), batchSync = vi.mocked(windowsFilePrivacyBatchSync);
const actions = (calls: unknown[][]) => calls.map(([operations]) => (operations as WindowsFilePrivacyOperation[]).map(o => `${o.action}:${o.path}`));

let root = '', log = '';
const logLines = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>) : [];
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'realbud-windows-admission-')));
  log = join(root, 'logs', 'realbud.log');
  // An existing log is appended to without an admission, so the recorded calls
  // below are only the ones under test.
  mkdirSync(join(root, 'logs'), { mode: 0o700 }); writeFileSync(log, '', { mode: 0o600 });
  setOpLogPath(log);
  batch.mockClear(); batchSync.mockClear();
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('repair of an existing object that only inherits private grants', () => {
  it('repairs an inherited-only folder, then admits it, and logs the role once without a path', async () => {
    const folder = join(root, 'fictional-data');
    batch.mockRejectedValueOnce(refusal('inheritance-not-protected'));
    await expect(admitPrivateObject(folder, 'directory', "RealBud's data folder")).resolves.toBe(true);
    expect(actions(batch.mock.calls)).toEqual([[`verify:${folder}`], [`repair:${folder}`]]);
    const lines = logLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: 'storage', kind: 'directory', repair: 'windows-acl:inheritance-not-protected' });
    expect(String(lines[0]!.detail)).toContain("RealBud's data folder");
    expect(readFileSync(log, 'utf8')).not.toContain(root);
    // Already protected: one verification, no repair, nothing logged.
    batch.mockClear();
    await expect(admitPrivateObject(folder, 'directory', "RealBud's data folder")).resolves.toBe(false);
    expect(actions(batch.mock.calls)).toEqual([[`verify:${folder}`]]);
    expect(logLines()).toHaveLength(1);
  });

  it('keeps an extra principal refused: the repair itself refuses and nothing is logged', async () => {
    const folder = join(root, 'shared');
    // Unprotected and inheriting an extra grant: verify reports inheritance
    // first; the repair judges the inherited rules and refuses before writing.
    batch.mockRejectedValueOnce(refusal('inheritance-not-protected')).mockRejectedValueOnce(refusal('grant-not-allowed'));
    await expect(admitPrivateObject(folder, 'directory', 'A RealBud storage folder')).rejects.toMatchObject({ category: 'grant-not-allowed' });
    expect(actions(batch.mock.calls)).toEqual([[`verify:${folder}`], [`repair:${folder}`]]);
    expect(logLines()).toEqual([]);
  });

  it.each(['grant-not-allowed', 'deny-rule-present', 'owner-not-allowed', 'target-reparse-point', 'powershell-not-found', 'process-terminated'])(
    'never attempts a repair for %s', async category => {
      batch.mockRejectedValueOnce(refusal(category));
      await expect(admitPrivateObject(join(root, 'x'), 'file', 'A RealBud storage file')).rejects.toMatchObject({ category });
      expect(batch).toHaveBeenCalledTimes(1);
      expect(logLines()).toEqual([]);
    });

  it('rethrows an ordinary error and a helper failure during the repair unchanged', async () => {
    const plain = new Error('fictional failure');
    batch.mockRejectedValueOnce(plain);
    await expect(admitPrivateObject(join(root, 'x'), 'file', 'A RealBud storage file')).rejects.toBe(plain);
    batch.mockRejectedValueOnce(refusal('inheritance-not-protected')).mockRejectedValueOnce(refusal('process-terminated'));
    await expect(admitPrivateObject(join(root, 'x'), 'file', 'A RealBud storage file')).rejects.toMatchObject({ category: 'process-terminated' });
    expect(logLines()).toEqual([]);
  });

  it('repairs only the refused verify of a batch, then continues after it in order', () => {
    const ops: WindowsFilePrivacyOperation[] = [
      { path: join(root, 'a'), kind: 'directory', action: 'verify' },
      { path: join(root, 'b'), kind: 'file', action: 'verify' },
      { path: join(root, 'c'), kind: 'file', action: 'restrict' },
    ];
    batchSync.mockImplementationOnce(() => { throw refusal('inheritance-not-protected', 1); });
    expect(admitPrivateObjectsSync(ops, "Bud's private profile")).toEqual([1]);
    expect(actions(batchSync.mock.calls)).toEqual([
      [`verify:${ops[0]!.path}`, `verify:${ops[1]!.path}`, `restrict:${ops[2]!.path}`],
      [`repair:${ops[1]!.path}`],
      [`restrict:${ops[2]!.path}`],
    ]);
    expect(logLines()).toHaveLength(1);
  });

  it('never repairs a restrict operation or a batch refusal without a usable index', async () => {
    const ops: WindowsFilePrivacyOperation[] = [
      { path: join(root, 'a'), kind: 'directory', action: 'verify' },
      { path: join(root, 'b'), kind: 'file', action: 'restrict' },
    ];
    batchSync.mockImplementationOnce(() => { throw refusal('inheritance-not-protected', 1); });
    expect(() => admitPrivateObjectsSync(ops, 'role')).toThrow(/inheritance-not-protected/);
    batch.mockRejectedValueOnce(refusal('inheritance-not-protected', null));
    await expect(admitPrivateObjects(ops, 'role')).rejects.toMatchObject({ category: 'inheritance-not-protected' });
    expect(batchSync).toHaveBeenCalledTimes(1); expect(batch).toHaveBeenCalledTimes(1);
    expect(admitPrivateObjectsSync([], 'role')).toEqual([]);
    expect(logLines()).toEqual([]);
  });
});

describe('private JSON admission of an older data folder', () => {
  it('repairs the data folder named at launch and writes the preflight probe into it', async () => {
    const data = join(root, 'fictional-data');
    await import('node:fs/promises').then(fs => fs.mkdir(data, { mode: 0o700 }));
    admitPrivateDirectorySync(data, "RealBud's data folder");
    batch.mockImplementation(async operations => {
      if (operations[0]!.path === data && operations[0]!.action === 'verify') throw refusal('inheritance-not-protected');
      return operations.map(o => ({ ...o, applied: true }));
    });
    const probe = join(data, '.service-provisioning-check-fictional.json');
    await writePrivateJson(probe, { version: 1 });
    expect(JSON.parse(readFileSync(probe, 'utf8'))).toEqual({ version: 1 });
    expect(actions(batch.mock.calls)).toContainEqual([`repair:${data}`]);
    expect(logLines().map(line => line.detail)).toEqual([expect.stringContaining("RealBud's data folder")]);
    expect(readFileSync(log, 'utf8')).not.toContain(data);
    batch.mockReset();
  });
});

describe('files and folders RealBud does not own, and the install lock', () => {
  it('only checks a file read with repair off, such as an operator-chosen bundle', async () => {
    const bundle = join(root, 'fictional-bundle.json');
    writeFileSync(bundle, '{"version":1}', { mode: 0o600 });
    const verify = vi.mocked(windowsFilePrivacy);
    verify.mockClear();
    verify.mockRejectedValueOnce(refusal('inheritance-not-protected'));
    await expect(readPrivateJson(bundle, 64_000, { repair: false })).rejects.toMatchObject({ category: 'inheritance-not-protected' });
    expect(verify).toHaveBeenCalledWith(bundle, 'file');
    expect(batch).not.toHaveBeenCalled();
    expect(logLines()).toEqual([]);
  });

  it('repairs the install lock folder before creating the lock', async () => {
    const folder = join(root, 'fictional-data');
    mkdirSync(folder, { mode: 0o700 });
    batch.mockRejectedValueOnce(refusal('inheritance-not-protected'));
    await writeNewPrivateFile(join(folder, '.fictional.lock'), '{}');
    expect(actions(batch.mock.calls)).toEqual([[`verify:${folder}`], [`repair:${folder}`]]);
    expect(readFileSync(join(folder, '.fictional.lock'), 'utf8')).toBe('{}');
  });
});
