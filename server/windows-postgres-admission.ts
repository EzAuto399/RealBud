import { execFile } from 'node:child_process';
import { win32 } from 'node:path';
import { promisify } from 'node:util';
import { stripServiceSecrets } from './service-child-env.ts';

const execFileAsync = promisify(execFile);
export class WindowsPostgresAdmissionError extends Error {
  readonly code: 'windows_postgres_privileged_token' | 'windows_postgres_admission_unavailable';
  readonly reason: 'privileged-token' | 'verification-unavailable';
  constructor(reason: 'privileged-token' | 'verification-unavailable') {
    super(reason === 'privileged-token'
      ? 'Office hosting needs a standard Windows user session. Close RealBud and reopen it without "Run as administrator". If this continues, use a standard Windows user account. Existing data and settings have been preserved.'
      : 'RealBud could not verify this Windows session\'s permissions. Close RealBud and reopen it normally, without "Run as administrator", then try again. Existing data and settings have been preserved.');
    this.code = reason === 'privileged-token' ? 'windows_postgres_privileged_token' : 'windows_postgres_admission_unavailable';
    this.reason = reason;
    this.name = 'WindowsPostgresAdmissionError';
  }
}

// IsInRole checks enabled token membership, like PostgreSQL's Windows admission.
// A normal UAC-filtered administrator token is not refused for deny-only groups.
// Built-in .NET types need neither Add-Type nor module auto-loading. The only
// output is a fixed role label: never a Windows identity or native diagnostic.
const SCRIPT = `
$ErrorActionPreference = 'Stop'
$PSModuleAutoLoadingPreference = 'None'
$identity = $null
try {
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
  if ($principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    [Console]::Out.Write('administrator')
  } elseif ($principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::PowerUser)) {
    [Console]::Out.Write('power-user')
  } else {
    [Console]::Out.Write('standard')
  }
} catch { exit 1 }
finally { if ($null -ne $identity) { $identity.Dispose() } }
exit 0
`;

type AdmissionDependencies = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  execute?: (file: string, args: readonly string[], options: {
    encoding: 'utf8'; env: NodeJS.ProcessEnv; signal?: AbortSignal;
    shell: false; windowsHide: true; timeout: number; maxBuffer: number;
  }) => Promise<{ stdout: string; stderr: string }>;
};

function checkAbort(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error('Owned PostgreSQL launch admission was aborted');
  error.name = 'AbortError';
  throw error;
}

/** Read-only admission before any owned database or host-settings writes. */
export async function assertWindowsPostgresAdmission(signal?: AbortSignal, dependencies: AdmissionDependencies = {}): Promise<void> {
  checkAbort(signal);
  if ((dependencies.platform ?? process.platform) !== 'win32') return;
  try {
    const env = { ...(dependencies.env ?? process.env) };
    stripServiceSecrets(env);
    const systemRoot = Object.entries(env).find(([key]) => key.toLowerCase() === 'systemroot')?.[1];
    if (!systemRoot || !/^[A-Za-z]:[\\/]/.test(systemRoot) || /[\0\r\n]/.test(systemRoot)) {
      throw new WindowsPostgresAdmissionError('verification-unavailable');
    }
    for (const key of Object.keys(env)) if (['systemroot', 'psmodulepath'].includes(key.toLowerCase())) delete env[key];
    env.SystemRoot = systemRoot;
    env.PSModulePath = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
    const execute = dependencies.execute ?? execFileAsync;
    const result = await execute(win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')],
      { encoding: 'utf8', env, signal, shell: false, windowsHide: true, timeout: 10_000, maxBuffer: 128 });
    checkAbort(signal);
    if (result.stderr !== '' || !['standard', 'administrator', 'power-user'].includes(result.stdout)) {
      throw new WindowsPostgresAdmissionError('verification-unavailable');
    }
    if (result.stdout !== 'standard') throw new WindowsPostgresAdmissionError('privileged-token');
  } catch (error) {
    checkAbort(signal);
    if (error instanceof WindowsPostgresAdmissionError) throw error;
    // Discard stdout, stderr, native errors, paths, identities and nested causes.
    throw new WindowsPostgresAdmissionError('verification-unavailable');
  }
}
