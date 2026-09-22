import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { inspect } from 'node:util';
import { windowsFilePrivacy, windowsFilePrivacySync } from './windows-file-privacy.ts';

const calls = vi.hoisted(() => ({ sync: vi.fn(), async: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: calls.sync, execFile: calls.async }));
vi.mock('node:path', async original => {
  const path = await original<typeof import('node:path')>();
  return { ...path, isAbsolute: path.win32.isAbsolute, join: path.win32.join };
});
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeEach(() => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  vi.stubEnv('SystemRoot', 'C:\\Windows'); calls.sync.mockReset(); calls.async.mockReset();
  calls.async.mockImplementation((...args: unknown[]) => (args.at(-1) as Function)(null, '', ''));
});
afterEach(() => { Object.defineProperty(process, 'platform', platform); vi.unstubAllEnvs(); });

it('uses the exact same ACL script, invocation and verify-only default as async callers', async () => {
  const path = 'C:\\private\\literal $() [file].txt';
  windowsFilePrivacySync(path, 'file'); await windowsFilePrivacy(path, 'file');
  const [program, args, options] = calls.sync.mock.calls[0]!;
  expect(calls.async.mock.calls[0]!.slice(0, 2)).toEqual([program, args]);
  expect(options).toMatchObject({ shell: false, windowsHide: true, timeout: 15_000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'pipe'], env: { REALBUD_WINDOWS_FILE_PRIVACY_PATH: path, REALBUD_WINDOWS_FILE_PRIVACY_ACTION: 'verify' } });
  expect(args.join(' ')).not.toContain(path);
  windowsFilePrivacySync(path, 'file', true);
  expect(calls.sync.mock.calls[1]![2].env.REALBUD_WINDOWS_FILE_PRIVACY_ACTION).toBe('restrict');
});

it.each([
  [{ status: 3 }, 'grant-not-allowed', 3], [{ status: 5 }, 'inheritance-not-protected', 5],
  [{ status: 24 }, 'acl-apply-failed', 24], [{ code: 'ENOENT', status: null }, 'powershell-not-found', null],
  [{ code: 'ENOBUFS' }, 'output-limit-exceeded', null], [{ code: 'ETIMEDOUT' }, 'process-terminated', null],
])('keeps synchronous failure %j fixed and free of native diagnostics', (fields, category, nativeExitCode) => {
  const secret = 'fictional-private-path-and-SID';
  calls.sync.mockImplementation(() => { throw Object.assign(new Error(secret), { ...fields, stdout: secret, stderr: secret, path: secret, cause: secret }); });
  let failure: unknown;
  try { windowsFilePrivacySync('C:\\private', 'file'); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ name: 'WindowsFilePrivacyError', category, nativeExitCode });
  expect(inspect(failure)).not.toContain(secret); expect(failure).not.toHaveProperty('cause');
});

it('rejects invalid input before launching and does nothing on other systems', () => {
  expect(() => windowsFilePrivacySync('relative', 'file')).toThrow(/invalid-path-or-kind/);
  expect(calls.sync).not.toHaveBeenCalled();
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
  windowsFilePrivacySync('/not-accessed', 'file', true);
  expect(calls.sync).not.toHaveBeenCalled();
});
