// The long-lived admission host, with win32 simulated and powershell.exe
// replaced by a scripted child. Native behaviour is covered on a real Windows
// runner by windows-file-privacy.test.ts, which goes through this host.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { inspect } from 'node:util';

type FakeChild = EventEmitter & { ended: boolean; stdin: PassThrough; stdout: PassThrough; kill: () => void; ref: () => void; unref: () => void; requests: string[] };
const spawned = vi.hoisted(() => ({ children: [] as unknown[], calls: [] as unknown[][], reply: (_child: unknown, _line: string): string | null => null }));
vi.mock('node:child_process', () => ({
  execFile: vi.fn(), execFileSync: vi.fn(),
  spawn: vi.fn((...args: unknown[]) => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), requests: [] as string[],
      kill: vi.fn(() => { if (!child.ended) { child.ended = true; queueMicrotask(() => child.emit('exit', null, 'SIGTERM')); } }), ref: vi.fn(), unref: vi.fn(), ended: false, exitCode: null, signalCode: null,
    }) as FakeChild;
    child.stdin.setEncoding('utf8');
    child.stdin.on('data', (chunk: string) => {
      for (const line of chunk.split('\n').filter(Boolean)) {
        child.requests.push(line);
        const answer = spawned.reply(child, line);
        if (answer !== null) child.stdout.write(answer);
      }
    });
    spawned.children.push(child); spawned.calls.push(args);
    return child;
  }),
}));
vi.mock('node:path', async original => {
  const path = await original<typeof import('node:path')>();
  return { ...path, isAbsolute: path.win32.isAbsolute, join: path.win32.join };
});
const { windowsFilePrivacy, windowsFilePrivacyBatch } = await import('./windows-file-privacy.ts');

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const admitAll = (_child: unknown, line: string) => `${line.split('\t')[0]}\t0\t\r\n`;
beforeEach(() => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  vi.stubEnv('SystemRoot', 'C:\\Windows');
  spawned.reply = admitAll;
});
afterEach(() => {
  // End any host a case left running so the next case starts clean.
  for (const child of spawned.children.splice(0) as FakeChild[]) child.emit('exit', 0, null);
  spawned.calls.length = 0;
  Object.defineProperty(process, 'platform', platform); vi.unstubAllEnvs();
});

it('serves many admissions from one host, with each path only as base64 data on stdin', async () => {
  const path = 'C:\\private\\literal $(`whoami`) & [account].txt';
  await windowsFilePrivacy(path, 'file', true);
  await windowsFilePrivacy('\\\\?\\C:\\private', 'directory');
  expect(spawned.calls).toHaveLength(1);
  const [executable, args, options] = spawned.calls[0] as [string, string[], { env: NodeJS.ProcessEnv; shell: boolean; windowsHide: boolean }];
  expect(executable).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  expect(args.slice(0, -1)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  expect(options).toMatchObject({ shell: false, windowsHide: true, env: { REALBUD_WINDOWS_FILE_PRIVACY_HOST: '1' } });
  expect(Object.keys(options.env).filter(name => /PRIVACY_(PATH|KIND|ACTION|COUNT)/.test(name))).toEqual([]);
  expect(JSON.stringify([args, options.env])).not.toContain('whoami');
  const requests = (spawned.children[0] as FakeChild).requests.map(line => line.split('\t'));
  expect(requests.map(([id, kind, action]) => [id, kind, action])).toEqual([['1', 'file', 'restrict'], ['2', 'directory', 'verify']]);
  expect(Buffer.from(requests[0]![3]!, 'base64').toString('utf8')).toBe(path);
  expect(Buffer.from(requests[1]![3]!, 'base64').toString('utf8')).toBe('C:\\private');
  // Idle, the host holds nothing open.
  expect((spawned.children[0] as FakeChild).unref).toHaveBeenCalled();
});

it('refuses with the native category, stops the batch there and keeps only the script\u2019s own detail', async () => {
  const detail = '[windows-acl] stage=24 index=0 type=System.UnauthorizedAccessException hresult=-2147024891 win32=5 fqid=-';
  spawned.reply = (_child, line) => { const id = line.split('\t')[0]; return id === '2' ? `${id}\t24\t${detail}\n` : `${id}\t0\t\n`; };
  const failure = await windowsFilePrivacyBatch([
    { path: 'C:\\a', kind: 'directory', action: 'verify' },
    { path: 'C:\\a\\b', kind: 'file', action: 'restrict' },
    { path: 'C:\\a\\c', kind: 'file', action: 'restrict' },
  ]).catch(error => error);
  expect(failure).toMatchObject({ name: 'WindowsFilePrivacyError', category: 'acl-apply-failed', nativeExitCode: 24, operationIndex: 1,
    detail: 'stage=24 index=0 type=System.UnauthorizedAccessException hresult=-2147024891 win32=5 fqid=-' });
  expect((spawned.children[0] as FakeChild).requests).toHaveLength(2);
  for (const [code, category] of [[5, 'inheritance-not-protected'], [6, 'target-reparse-point'], [8, 'ancestor-reparse-point'], [2, 'owner-not-allowed'], [77, 'native-command-failed']] as const) {
    spawned.reply = (_child, line) => `${line.split('\t')[0]}\t${code}\tC:\\fictional\\private\\path-and-SID\n`;
    const refused = await windowsFilePrivacy('C:\\a', 'directory').catch(error => error);
    expect(refused).toMatchObject({ category, nativeExitCode: code, detail: null });
    expect(inspect(refused)).not.toContain('path-and-SID');
  }
});

it('refuses everything in flight when the host dies, answers out of order or floods, then starts a fresh one', async () => {
  spawned.reply = child => { queueMicrotask(() => (child as FakeChild).emit('exit', 1, null)); return null; };
  await expect(windowsFilePrivacy('C:\\a', 'directory')).rejects.toMatchObject({ category: 'process-terminated' });
  spawned.reply = () => '99\t0\t\n';
  await expect(windowsFilePrivacy('C:\\a', 'directory')).rejects.toMatchObject({ category: 'process-terminated' });
  spawned.reply = () => 'x'.repeat(20_000);
  await expect(windowsFilePrivacy('C:\\a', 'directory')).rejects.toMatchObject({ category: 'output-limit-exceeded' });
  spawned.reply = admitAll;
  await expect(windowsFilePrivacy('C:\\a', 'directory')).resolves.toBeUndefined();
  expect(spawned.calls).toHaveLength(4);
});

it('reports a host that cannot start as the same launch failure', async () => {
  spawned.reply = child => { queueMicrotask(() => (child as FakeChild).emit('error', Object.assign(new Error('fixture-private-detail'), { code: 'ENOENT' }))); return null; };
  const failure = await windowsFilePrivacy('C:\\a', 'directory').catch(error => error);
  expect(failure).toMatchObject({ category: 'powershell-not-found', nativeExitCode: null });
  expect(inspect(failure)).not.toContain('fixture-private-detail');
});

it('validates before starting a host, and the kill switch keeps the one-shot launch', async () => {
  await expect(windowsFilePrivacy('relative', 'file')).rejects.toMatchObject({ category: 'invalid-path-or-kind' });
  expect(spawned.calls).toHaveLength(0);
  vi.stubEnv('REALBUD_WINDOWS_PRIVACY_HOST', '0');
  const { execFile } = await import('node:child_process');
  vi.mocked(execFile).mockImplementation(((...args: unknown[]) => (args.at(-1) as Function)(null, '', '')) as never);
  await windowsFilePrivacy('C:\\a', 'directory');
  expect(spawned.calls).toHaveLength(0);
  expect(execFile).toHaveBeenCalledTimes(1);
});
