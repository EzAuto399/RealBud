import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspect } from 'node:util';
import { windowsFilePrivacy } from './windows-file-privacy.ts';

const subprocess = vi.hoisted(() => ({ run: vi.fn<(...args: unknown[]) => void>() }));
vi.mock('node:child_process', () => ({ execFile: subprocess.run }));
vi.mock('node:path', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:path')>();
  return { ...original, isAbsolute: original.win32.isAbsolute, join: original.win32.join };
});

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
function result(error: unknown = null) {
  subprocess.run.mockImplementation((...args) => {
    const callback = args.at(-1) as (error: unknown, stdout: string, stderr: string) => void;
    callback(error, '', '');
  });
}
function launched(call = 0) {
  return (subprocess.run.mock.calls[call] as [string, string[], { env: NodeJS.ProcessEnv }])[2].env;
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  vi.stubEnv('SystemRoot', 'C:\\Windows');
  subprocess.run.mockReset();
  result();
});
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  vi.unstubAllEnvs();
});

describe('Windows privacy subprocess boundary (simulated Windows)', () => {
  it('uses a fixed encoded script and environment-only literal path for restrict and verify', async () => {
    const path = 'C:\\private\\literal $(`whoami`) & [account].txt';
    await windowsFilePrivacy(path, 'file', true);
    await windowsFilePrivacy(path, 'file');
    const [executable, args, options] = subprocess.run.mock.calls[0] as [string, string[], {
      shell: boolean; windowsHide: boolean; timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv;
    }];
    expect(executable).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(args.slice(0, -1)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand']);
    const script = Buffer.from(args.at(-1)!, 'base64').toString('utf16le');
    expect(script).toContain('$env:REALBUD_WINDOWS_FILE_PRIVACY_PATH');
    expect(script).not.toContain(path);
    expect(script).not.toContain('whoami');
    expect(options).toMatchObject({ shell: false, windowsHide: true, timeout: 15_000, maxBuffer: 4096 });
    expect(options.env).toMatchObject({
      REALBUD_WINDOWS_FILE_PRIVACY_PATH: path,
      REALBUD_WINDOWS_FILE_PRIVACY_KIND: 'file',
      REALBUD_WINDOWS_FILE_PRIVACY_ACTION: 'restrict',
    });
    expect(subprocess.run.mock.calls[1][1]).toEqual(args);
    expect(subprocess.run.mock.calls[1][2]).toMatchObject({ env: { REALBUD_WINDOWS_FILE_PRIVACY_ACTION: 'verify' } });
  });

  it.each([
    [2, 'owner-not-allowed'], [3, 'grant-not-allowed'], [4, 'target-full-control-missing'],
    [5, 'inheritance-not-protected'], [6, 'target-reparse-point'], [7, 'target-kind-mismatch'],
    [8, 'ancestor-reparse-point'], [9, 'invalid-invocation'], [10, 'deny-rule-present'],
    [20, 'identity-unavailable'], [21, 'target-inspection-failed'], [22, 'ancestor-inspection-failed'],
    [23, 'descriptor-construction-failed'], [24, 'acl-apply-failed'], [25, 'acl-read-failed'],
    [26, 'acl-inspection-failed'], [1, 'native-command-failed'], [4294967295, 'native-command-failed'],
  ])('reports native exit %s as %s without allowing admission', async (code, category) => {
    result(Object.assign(new Error('native details must stay private'), { code }));
    await expect(windowsFilePrivacy('C:\\private', 'directory', true)).rejects.toMatchObject({
      name: 'WindowsFilePrivacyError', category, nativeExitCode: code,
      message: expect.stringContaining(`[windows-acl:${category}; exit=${code}]`),
    });
  });

  it.each([
    [{ code: 'ENOENT' }, 'powershell-not-found'],
    [{ code: 'EACCES' }, 'powershell-launch-denied'],
    [{ code: 'EPERM' }, 'powershell-launch-denied'],
    [{ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true }, 'output-limit-exceeded'],
    [{ killed: true, signal: 'SIGTERM' }, 'process-terminated'],
    [{ code: 'private native diagnostic' }, 'native-command-failed'],
    [{ code: -1 }, 'native-command-failed'],
    [{ code: Number.NaN }, 'native-command-failed'],
  ])('classifies process failure %j without copying native details', async (fields, category) => {
    const secret = 'fixture-private-path-and-SID';
    result(Object.assign(new Error(secret), { ...fields, stdout: secret, stderr: secret, cmd: secret, path: secret, cause: secret }));
    let failure: unknown;
    try { await windowsFilePrivacy(`C:\\${secret}`, 'directory'); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ category, nativeExitCode: null });
    expect(inspect(failure)).not.toContain(secret);
    expect(JSON.stringify(failure)).not.toContain(secret);
    expect(inspect(failure)).not.toContain('private native diagnostic');
    expect(failure).not.toHaveProperty('cause');
    expect(failure).not.toHaveProperty('stderr');
  });

  it('rejects invalid paths and unavailable trusted PowerShell roots before launching', async () => {
    for (const path of ['relative', 'C:\\private\0suffix']) {
      await expect(windowsFilePrivacy(path, 'file')).rejects.toMatchObject({ category: 'invalid-path-or-kind', nativeExitCode: null });
    }
    await expect(windowsFilePrivacy('C:\\private', 'unknown' as 'file')).rejects.toMatchObject({ category: 'invalid-path-or-kind' });
    for (const root of ['', 'relative']) {
      vi.stubEnv('SystemRoot', root);
      await expect(windowsFilePrivacy('C:\\private', 'file')).rejects.toMatchObject({ category: 'system-root-unavailable', nativeExitCode: null });
    }
    expect(subprocess.run).not.toHaveBeenCalled();
  });

  it('hands the script a path the FileSystem provider accepts, byte-for-byte otherwise', async () => {
    await windowsFilePrivacy('\\\\?\\C:\\private\\key [file].txt', 'file', true);
    expect(launched(0).REALBUD_WINDOWS_FILE_PRIVACY_PATH).toBe('C:\\private\\key [file].txt');
    await windowsFilePrivacy('\\\\?\\UNC\\fictional-host\\share\\private', 'directory');
    expect(launched(1).REALBUD_WINDOWS_FILE_PRIVACY_PATH).toBe('\\\\fictional-host\\share\\private');
    // Nothing else is rewritten: a plain path, and one that merely looks close.
    await windowsFilePrivacy('C:\\private\\\\?\\not-a-prefix', 'file');
    expect(launched(2).REALBUD_WINDOWS_FILE_PRIVACY_PATH).toBe('C:\\private\\\\?\\not-a-prefix');
    // A namespaced path that is not absolute once stripped is still refused.
    await expect(windowsFilePrivacy('\\\\?\\relative', 'file')).rejects.toMatchObject({ category: 'invalid-path-or-kind' });
    expect(subprocess.run).toHaveBeenCalledTimes(3);
  });

  it('reports the swallowed native exception the script names, and nothing else', async () => {
    const line = '[windows-acl] stage=24 index=0 type=System.UnauthorizedAccessException hresult=-2147024891 win32=5';
    const secret = 'C:\\fictional\\private\\path-and-SID';
    // execFile decorates its own error with the captured streams.
    const stderr = `${secret}\r\n${line}\r\n`;
    subprocess.run.mockImplementation((...args) => {
      (args.at(-1) as (error: unknown, stdout: string, stderr: string) => void)(
        Object.assign(new Error(secret), { code: 24, stdout: '0\r\n', stderr }), '0\r\n', stderr,
      );
    });
    let failure: unknown;
    try { await windowsFilePrivacy('C:\\private', 'directory', true); } catch (error) { failure = error; }
    expect(failure).toMatchObject({
      category: 'acl-apply-failed', nativeExitCode: 24,
      detail: 'stage=24 index=0 type=System.UnauthorizedAccessException hresult=-2147024891 win32=5',
      message: expect.stringContaining('[windows-acl:acl-apply-failed; exit=24; stage=24 index=0'),
    });
    expect(inspect(failure)).not.toContain(secret);
  });

  it('keeps a stderr line that is not the script\u2019s own out of the failure', async () => {
    const secret = 'fictional-private-path-and-SID';
    for (const stderr of [
      secret,
      `[windows-acl] stage=24 index=0 type=System.Exception hresult=-1 win32=5 ${secret}`,
      `[windows-acl] stage=24 index=0 type=${secret} hresult=-1 win32=5`,
    ]) {
      subprocess.run.mockImplementation((...args) => {
        (args.at(-1) as (error: unknown, stdout: string, stderr: string) => void)(
          Object.assign(new Error(secret), { code: 25, stderr }), '', stderr,
        );
      });
      let failure: unknown;
      try { await windowsFilePrivacy('C:\\private', 'directory'); } catch (error) { failure = error; }
      expect(failure).toMatchObject({ category: 'acl-read-failed', detail: null });
      expect((failure as Error).message).toBe(
        'Windows file privacy could not be verified. Use a private directory owned by the trusted installer account. [windows-acl:acl-read-failed; exit=25]',
      );
      expect(inspect(failure)).not.toContain(secret);
    }
  });

  it('leaves other platforms untouched without launching PowerShell', async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
    await expect(windowsFilePrivacy('/does-not-exist', 'file', true)).resolves.toBeUndefined();
    expect(subprocess.run).not.toHaveBeenCalled();
  });
});
