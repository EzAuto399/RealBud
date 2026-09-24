import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { assertWindowsPostgresAdmission, WindowsPostgresAdmissionError } from './windows-postgres-admission.ts';

const env = { SystemRoot: 'C:\\Windows' };
const secret = 'fictional-private-Windows-identity';
const reply = (stdout = 'standard', stderr = '') => vi.fn().mockResolvedValue({ stdout, stderr });

describe('Windows PostgreSQL launch admission', () => {
  it.each(['darwin', 'linux'] as const)('does not inspect Windows state or launch a process on %s', async platform => {
    const execute = vi.fn().mockRejectedValue(new Error('must not run'));
    await assertWindowsPostgresAdmission(undefined, { platform, env: {}, execute });
    expect(execute).not.toHaveBeenCalled();
  });

  it('admits the exact standard-token reply using a bounded, pinned, secret-stripped invocation', async () => {
    const source = { systemroot: 'C:\\Windows', PSModulePath: 'fictional-pwsh-modules', psmodulepath: 'fictional-other-modules',
      PATH: 'fictional-path', REALBUD_COMPANY_DATABASE_URL: secret, PGPASSWORD: secret };
    const execute = reply();
    await assertWindowsPostgresAdmission(undefined, { platform: 'win32', env: source, execute });
    expect(execute).toHaveBeenCalledOnce();
    const [file, args, options] = execute.mock.calls[0]!;
    expect(file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand']);
    const script = Buffer.from(args[3], 'base64').toString('utf16le');
    expect(script).toContain('WindowsPrincipal]::new($identity)');
    expect(script).toContain('WindowsBuiltInRole]::Administrator');
    expect(script).toContain('WindowsBuiltInRole]::PowerUser');
    expect(script).not.toMatch(/\b(?:Add-Type|New-Object|Get-LocalGroupMember)\b/);
    expect(options).toMatchObject({ encoding: 'utf8', shell: false, windowsHide: true, timeout: 10_000, maxBuffer: 128,
      env: { SystemRoot: 'C:\\Windows', PATH: 'fictional-path', PSModulePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules' } });
    expect(Object.keys(options.env).filter(key => key.toLowerCase() === 'psmodulepath')).toEqual(['PSModulePath']);
    expect(Object.keys(options.env).filter(key => key.toLowerCase() === 'systemroot')).toEqual(['SystemRoot']);
    expect(inspect(options)).not.toContain(secret);
    expect(source.PSModulePath).toBe('fictional-pwsh-modules');
    expect(source.REALBUD_COMPANY_DATABASE_URL).toBe(secret);
  });

  it.each(['administrator', 'power-user'])('refuses enabled %s membership with fixed recovery guidance', async role => {
    const failure = await assertWindowsPostgresAdmission(undefined, { platform: 'win32', env, execute: reply(role) }).catch(error => error);
    expect(failure).toBeInstanceOf(WindowsPostgresAdmissionError);
    expect(failure).toMatchObject({ reason: 'privileged-token', code: 'windows_postgres_privileged_token' });
    expect(failure.message).toContain('Office hosting needs a standard Windows user session');
    expect(failure.message).toContain('Close RealBud and reopen it without "Run as administrator"');
    expect(failure.message).toContain('If this continues, use a standard Windows user account');
  });

  it.each([
    ['', ''], ['standard\r\n', ''], ['standard\nstandard', ''], ['unknown', ''],
    ['standard', secret], ['administrator', secret],
  ])('refuses incomplete or contaminated replies (%j, %j) without claiming elevation', async (stdout, stderr) => {
    const failure = await assertWindowsPostgresAdmission(undefined, { platform: 'win32', env, execute: reply(stdout, stderr) }).catch(error => error);
    expect(failure).toMatchObject({ reason: 'verification-unavailable', code: 'windows_postgres_admission_unavailable' });
    expect(failure.message).toContain('could not verify');
    expect(failure.message).not.toContain('cannot start office storage with administrator');
    expect(inspect(failure)).not.toContain(secret);
  });

  it.each([1, 'ENOENT', 'ETIMEDOUT', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'])('discards the native failure %s and all its private context', async code => {
    const execute = vi.fn().mockRejectedValue(Object.assign(new Error(secret), {
      code, stdout: 'administrator', stderr: secret, path: secret, cause: new Error(secret),
    }));
    const failure = await assertWindowsPostgresAdmission(undefined, { platform: 'win32', env, execute }).catch(error => error);
    expect(failure).toMatchObject({ name: 'WindowsPostgresAdmissionError', reason: 'verification-unavailable' });
    expect(failure).not.toHaveProperty('cause');
    expect(inspect(failure)).not.toContain(secret);
  });

  it.each([undefined, '', 'relative', '\\Windows', 'C:\\Windows\0fictional'])('refuses an unavailable trusted SystemRoot (%j) before launching', async SystemRoot => {
    const execute = reply();
    await expect(assertWindowsPostgresAdmission(undefined, { platform: 'win32', env: { SystemRoot }, execute }))
      .rejects.toMatchObject({ reason: 'verification-unavailable' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not launch after cancellation or accept a late successful reply after cancellation', async () => {
    const early = new AbortController(); early.abort();
    const execute = reply();
    await expect(assertWindowsPostgresAdmission(early.signal, { platform: 'win32', env, execute })).rejects.toMatchObject({ name: 'AbortError' });
    expect(execute).not.toHaveBeenCalled();
    const late = new AbortController();
    await expect(assertWindowsPostgresAdmission(late.signal, { platform: 'win32', env,
      execute: async (_file, _args, options) => { expect(options.signal).toBe(late.signal); late.abort(); return { stdout: 'standard', stderr: '' }; },
    })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
