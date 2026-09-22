import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { windowsFilePrivacy, windowsFilePrivacyBatchSync } from './windows-file-privacy.ts';
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
Set-Acl -LiteralPath $env:REALBUD_TEST_ACL_PATH -AclObject $acl
`, 'utf16le').toString('base64');

async function setTestAcl(path: string, mode: 'inherit-only' | 'deny-write') {
  await promisify(execFile)(join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', SET_TEST_ACL], {
      env: { ...process.env, REALBUD_TEST_ACL_PATH: path, REALBUD_TEST_ACL_MODE: mode },
      shell: false, windowsHide: true, timeout: 15_000, maxBuffer: 4096,
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
