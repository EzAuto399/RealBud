import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { windowsFilePrivacy, windowsFilePrivacyBatch, windowsFilePrivacyBatchSync, windowsFilePrivacySync } from './windows-file-privacy.ts';
import { writeNewPrivateFile } from './private-file.ts';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
// Canonicalize like server/testing/private-profile-fixture.ts: the ancestor walk
// and the reparse-point rejection both read the literal path, and a Windows
// TMP can hand back an 8.3 short name (or a macOS /var symlink) for mkdtemp.
async function fixture() { const root = await realpath(await mkdtemp(join(tmpdir(), 'realbud-native-acl-'))); roots.push(root); await windowsFilePrivacy(root, 'directory', true); return root; }

// These descriptors deliberately retain a readable/repairable DACL for the
// test's owner while withholding a target grant or denying a specific write.
const SET_TEST_ACL = Buffer.from(`
$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$acl = [System.Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($system, 'FullControl', 'Allow'))
if ($env:REALBUD_TEST_ACL_MODE -eq 'inherit-only') {
  $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'ReadAndExecute', 'Allow'))
  $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'InheritOnly', 'Allow'))
} elseif ($env:REALBUD_TEST_ACL_MODE -eq 'deny-write') {
  $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow'))
  $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'WriteData', 'Deny'))
} else { exit 9 }
([System.IO.DirectoryInfo]::new($env:REALBUD_TEST_ACL_PATH)).SetAccessControl($acl)
`, 'utf16le').toString('base64');

async function setTestAcl(path: string, mode: 'inherit-only' | 'deny-write') {
  await promisify(execFile)(join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', SET_TEST_ACL], {
      env: { ...process.env, REALBUD_TEST_ACL_PATH: path, REALBUD_TEST_ACL_MODE: mode },
      shell: false, windowsHide: true, timeout: 120_000, maxBuffer: 4096,
    });
}

it.skipIf(process.platform === 'win32')('does not run Windows ACL operations on another OS', async () => {
  await expect(windowsFilePrivacy('/no-file-is-accessed', 'file')).resolves.toBeUndefined();
  // A batch reports what it did, so a no-op is never mistaken for an admission.
  expect(windowsFilePrivacyBatchSync([
    { path: '/no-file-is-accessed', kind: 'file', action: 'verify' },
    { path: '/no-directory-is-accessed', kind: 'directory', action: 'restrict' },
  ])).toEqual([
    { path: '/no-file-is-accessed', kind: 'file', action: 'verify', applied: false },
    { path: '/no-directory-is-accessed', kind: 'directory', action: 'restrict', applied: false },
  ]);
});

// The synchronous form, with win32 simulated on this thread and powershell.exe
// replaced by a Node script under a scratch SystemRoot. The worker thread that
// owns the host is real, so this proves the thread hop, not the ACL policy
// (the native suite below covers that on a Windows runner). The fake decides
// from the requested path: "refuse-N" answers N, "crash" exits, "hang" stays
// silent, "garble" answers out of order; everything else is admitted.
const FAKE_POWERSHELL = String.raw`#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const log = require('node:path').join(__dirname, 'log');
const host = process.env.REALBUD_WINDOWS_FILE_PRIVACY_HOST === '1';
appendFileSync(log, 'start ' + process.pid + ' ' + (host ? 'host' : 'oneshot ' + process.env.REALBUD_WINDOWS_FILE_PRIVACY_PATH) + '\n');
if (!host) process.exit(0);
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('end', () => process.exit(9));
process.stdin.on('data', chunk => {
  buffer += chunk;
  for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
    const [id, kind, action, encoded] = buffer.slice(0, end).split('\t');
    buffer = buffer.slice(end + 1);
    const path = Buffer.from(encoded, 'base64').toString('utf8');
    appendFileSync(log, 'request ' + process.pid + ' ' + kind + ' ' + action + ' ' + path + '\n');
    if (path.includes('crash')) process.exit(1);
    if (path.includes('hang')) continue;
    if (path.includes('garble')) { process.stdout.write('999\t0\t\n'); continue; }
    const refuse = /refuse-(\d+)/.exec(path);
    process.stdout.write(refuse
      ? id + '\t' + refuse[1] + '\t[windows-acl] stage=24 index=0 type=System.IO.IOException hresult=-2147024891 win32=5\r\n'
      : id + '\t0\t\r\n');
  }
});
`;

describe.skipIf(process.platform === 'win32')('synchronous admissions through the long-lived host', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  let systemRoot = '';
  const log = async () => (await readFile(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'log'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
  const failureOf = (run: () => unknown) => { try { run(); } catch (error) { return error; } throw new Error('expected a refusal'); };
  const fields = (error: unknown) => {
    const { name, message, category, nativeExitCode, operationIndex, detail } = error as Record<string, unknown>;
    return { name, message, category, nativeExitCode, operationIndex, detail };
  };
  beforeAll(async () => {
    systemRoot = await realpath(await mkdtemp(join(tmpdir(), 'realbud-fake-systemroot-')));
    const folder = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0');
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'powershell.exe'), FAKE_POWERSHELL); await chmod(join(folder, 'powershell.exe'), 0o755);
  });
  beforeEach(async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    vi.stubEnv('SystemRoot', systemRoot);
    await rm(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'log'), { force: true });
  });
  afterEach(() => { Object.defineProperty(process, 'platform', platform); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
  afterAll(() => rm(systemRoot, { recursive: true, force: true }));

  it('serves several synchronous calls from one long-lived host process', async () => {
    windowsFilePrivacySync('/fictional/a', 'directory', true);
    windowsFilePrivacySync('/fictional/a/b.txt', 'file');
    expect(windowsFilePrivacyBatchSync([
      { path: '/fictional/c', kind: 'directory', action: 'verify' },
      { path: '/fictional/c/d.txt', kind: 'file', action: 'restrict' },
    ])).toEqual([
      { path: '/fictional/c', kind: 'directory', action: 'verify', applied: true },
      { path: '/fictional/c/d.txt', kind: 'file', action: 'restrict', applied: true },
    ]);
    const lines = await log();
    const starts = lines.filter(line => line.startsWith('start '));
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatch(/^start \d+ host$/);
    const pid = starts[0]!.split(' ')[1];
    expect(lines.filter(line => line.startsWith('request ')).map(line => line.split(' ').slice(1).join(' '))).toEqual([
      `${pid} directory restrict /fictional/a`, `${pid} file verify /fictional/a/b.txt`,
      `${pid} directory verify /fictional/c`, `${pid} file restrict /fictional/c/d.txt`,
    ]);
  });

  it('rebuilds a refusal with exactly the asynchronous path’s fields and stops at it', async () => {
    const batch = [
      { path: '/fictional/ok', kind: 'directory' as const, action: 'verify' as const },
      { path: '/fictional/refuse-24', kind: 'file' as const, action: 'restrict' as const },
      { path: '/fictional/never', kind: 'file' as const, action: 'restrict' as const },
    ];
    const synchronous = failureOf(() => windowsFilePrivacyBatchSync(batch));
    const asynchronous = await windowsFilePrivacyBatch(batch).catch(error => error);
    expect(fields(synchronous)).toEqual(fields(asynchronous));
    expect(synchronous).toMatchObject({
      name: 'WindowsFilePrivacyError', category: 'acl-apply-failed', nativeExitCode: 24, operationIndex: 1,
      detail: 'stage=24 index=0 type=System.IO.IOException hresult=-2147024891 win32=5',
      message: expect.stringContaining('exit=24; operation=1/3'),
    });
    expect((await log()).filter(line => line.includes('/fictional/never'))).toEqual([]);
    const single = failureOf(() => windowsFilePrivacySync('/fictional/refuse-5', 'directory'));
    expect(fields(single)).toEqual(fields(await windowsFilePrivacy('/fictional/refuse-5', 'directory').catch(error => error)));
    expect(single).toMatchObject({ category: 'inheritance-not-protected', nativeExitCode: 5, operationIndex: null });
  });

  it('fails closed when the host crashes, answers out of order or the worker hangs, then recovers', async () => {
    for (const path of ['/fictional/crash', '/fictional/garble']) {
      expect(failureOf(() => windowsFilePrivacySync(path, 'directory'))).toMatchObject({ category: 'process-terminated', nativeExitCode: null });
      expect(() => windowsFilePrivacySync('/fictional/after', 'directory')).not.toThrow();
    }
    // A worker that never answers is terminated at the deadline and the call refused.
    const wait = vi.spyOn(Atomics, 'wait').mockReturnValueOnce('timed-out');
    expect(failureOf(() => windowsFilePrivacySync('/fictional/hang', 'directory'))).toMatchObject({ category: 'process-terminated' });
    wait.mockRestore();
    expect(() => windowsFilePrivacySync('/fictional/after', 'directory')).not.toThrow();
    // Each failure ended its host; every recovery started a fresh one.
    expect((await log()).filter(line => line.startsWith('start '))).toHaveLength(3);
  });

  it('keeps the one-shot launch when the host is switched off', async () => {
    vi.stubEnv('REALBUD_WINDOWS_PRIVACY_HOST', '0');
    windowsFilePrivacySync('/fictional/one-shot', 'directory');
    expect(await log()).toEqual([expect.stringMatching(/^start \d+ oneshot \/fictional\/one-shot$/)]);
  });
});

describe.skipIf(process.platform !== 'win32')('native Windows privacy admission', () => {
  it('admits a newly protected directory and a file protected before content is written', async () => {
    const root = await fixture(); const path = join(root, 'secret.txt');
    await writeNewPrivateFile(path, 'fictional credential');
    await expect(windowsFilePrivacy(root, 'directory')).resolves.toBeUndefined();
    await expect(windowsFilePrivacy(path, 'file')).resolves.toBeUndefined();
    expect(await readFile(path, 'utf8')).toBe('fictional credential');
  });
  it('applies an ordered list in one process and stops at the refusing operation', async () => {
    const root = await fixture(), nested = join(root, 'nested'); await mkdir(nested);
    // A file created under the protected root inherits its ACEs, so its own
    // descriptor is unprotected: a real refusal, not a simulated one.
    const inherited = join(root, 'inherited.txt'); await writeFile(inherited, 'preserved');
    expect(windowsFilePrivacyBatchSync([
      { path: root, kind: 'directory', action: 'verify' },
      { path: nested, kind: 'directory', action: 'restrict' },
    ])).toEqual([
      { path: root, kind: 'directory', action: 'verify', applied: true },
      { path: nested, kind: 'directory', action: 'restrict', applied: true },
    ]);

    const unreached = join(nested, 'unreached'); await mkdir(unreached);
    let failure: unknown;
    try {
      windowsFilePrivacyBatchSync([
        { path: root, kind: 'directory', action: 'verify' },
        { path: inherited, kind: 'file', action: 'verify' },
        { path: unreached, kind: 'directory', action: 'restrict' },
      ]);
    } catch (error) { failure = error; }
    expect(failure).toMatchObject({ category: 'inheritance-not-protected', nativeExitCode: 5, operationIndex: 1 });
    expect(await readFile(inherited, 'utf8')).toBe('preserved');
    // Nothing after the refusal ran: the trailing restrict never happened.
    await expect(windowsFilePrivacy(unreached, 'directory')).rejects.toMatchObject({ category: 'inheritance-not-protected' });
  });

  it('admits the same directory through its Win32 namespaced form', async () => {
    // The .NET access-control calls refuse \\?\ on PowerShell 5.1 even though the
    // ancestor walk accepts it, so the Node side strips it before the script.
    const root = await fixture();
    await expect(windowsFilePrivacy(`\\\\?\\${root}`, 'directory')).resolves.toBeUndefined();
    expect(windowsFilePrivacyBatchSync([{ path: `\\\\?\\${root}`, kind: 'directory', action: 'restrict' }]))
      .toEqual([{ path: `\\\\?\\${root}`, kind: 'directory', action: 'restrict', applied: true }]);
  });

  it('rejects an inherited, unprotected existing file without repairing it', async () => {
    const root = await fixture(); const path = join(root, 'inherited.txt'); await writeFile(path, 'preserved');
    await expect(windowsFilePrivacy(path, 'file')).rejects.toMatchObject({ category: 'inheritance-not-protected', nativeExitCode: 5 });
    expect(await readFile(path, 'utf8')).toBe('preserved');
    await expect(windowsFilePrivacy(path, 'file')).rejects.toMatchObject({ category: 'inheritance-not-protected', nativeExitCode: 5 });
  });
  it('rejects kind mismatch and relative paths', async () => {
    const root = await fixture();
    await expect(windowsFilePrivacy(root, 'file')).rejects.toMatchObject({ category: 'target-kind-mismatch', nativeExitCode: 7 });
    await expect(windowsFilePrivacy('relative', 'directory')).rejects.toMatchObject({ category: 'invalid-path-or-kind', nativeExitCode: null });
  });
  it('rejects a junction and an ancestor junction without touching the target', async () => {
    const root = await fixture(); const target = join(root, 'actual'); await mkdir(target); await windowsFilePrivacy(target, 'directory', true);
    const path = join(target, 'secret.txt'); await writeNewPrivateFile(path, 'preserved');
    const junction = join(root, 'linked'); await symlink(target, junction, 'junction');
    await expect(windowsFilePrivacy(junction, 'directory', true)).rejects.toMatchObject({ category: 'target-reparse-point', nativeExitCode: 6 });
    await expect(windowsFilePrivacy(join(junction, 'secret.txt'), 'file', true)).rejects.toMatchObject({ category: 'ancestor-reparse-point', nativeExitCode: 8 });
    expect(await readFile(path, 'utf8')).toBe('preserved');
    await expect(windowsFilePrivacy(path, 'file')).resolves.toBeUndefined();
  });
  it.each([
    ['inherit-only', 'target-full-control-missing', 4],
    ['deny-write', 'deny-rule-present', 10],
  ] as const)('rejects %s ACL without repairing an existing directory', async (mode, category, nativeExitCode) => {
    const root = await fixture();
    try {
      await setTestAcl(root, mode);
      await expect(windowsFilePrivacy(root, 'directory')).rejects.toMatchObject({ category, nativeExitCode });
      // Verify-only must leave the rejected descriptor in place.
      await expect(windowsFilePrivacy(root, 'directory')).rejects.toMatchObject({ category, nativeExitCode });
    } finally {
      // Only this disposable, test-owned directory is repaired for cleanup.
      await windowsFilePrivacy(root, 'directory', true);
    }
  });
});
