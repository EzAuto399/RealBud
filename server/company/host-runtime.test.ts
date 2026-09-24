import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { openOwnedPostgres, postgresBinary, stopOwnedPostgresProcess } from './host-runtime.ts';
import { privateDir, removeFixture } from '../testing/private-fixture.ts';
import { assertWindowsPostgresAdmission, WindowsPostgresAdmissionError } from '../windows-postgres-admission.ts';

vi.mock('../windows-postgres-admission.ts', async original => ({
  ...await original<typeof import('../windows-postgres-admission.ts')>(), assertWindowsPostgresAdmission: vi.fn(),
}));
// PostgreSQL is already simulated in this suite. Token-query behavior belongs
// to windows-postgres-admission.test.ts and the separate native launch proof.
beforeEach(() => { vi.mocked(assertWindowsPostgresAdmission).mockReset().mockResolvedValue(); });

/** A port nothing is listening on right now: fixed ports collide on shared CI runners. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}


const temps: string[] = [];

describe('Windows native PostgreSQL shutdown contract', () => {
  it('uses pg_ctl only after matching the owned postmaster identity', async () => {
    const { rootDirectory, binaryDirectory } = await workspace();
    await writeFile(join(rootDirectory, 'postmaster.pid'), `4242\n${rootDirectory}\n`);
    let exited = false;
    const child = { pid: 4242, get exitCode() { return exited ? 0 : null; }, kill() { throw new Error('Node must not terminate PostgreSQL on Windows'); }, once() {} };
    await stopOwnedPostgresProcess(child, { platform: 'win32', binaryDirectory, dataDirectory: rootDirectory,
      execute: async (file, args) => {
        expect(file).toBe(postgresBinary(binaryDirectory, 'pg_ctl', 'win32'));
        expect(args).toEqual(['-D', rootDirectory, '-m', 'fast', '-w', '-t', '10', 'stop']);
        exited = true; return { stdout: '', stderr: '' };
      } });
    expect(exited).toBe(true);
  });
  it('refuses a different postmaster and preserves the process', async () => {
    const { rootDirectory, binaryDirectory } = await workspace();
    await writeFile(join(rootDirectory, 'postmaster.pid'), `9999\n${rootDirectory}\n`);
    const child = fakeProcess();
    await expect(stopOwnedPostgresProcess(child, { platform: 'win32', binaryDirectory, dataDirectory: rootDirectory,
      execute: async () => { throw new Error('Must not invoke another process'); } })).rejects.toThrow('identity changed');
    expect(child.exitCode).toBeNull();
  });
});

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => removeFixture(dir)));
});

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function workspace() {
  const temp = await mkdtemp(join(tmpdir(), 'rb-host-pg-'));
  temps.push(temp);
  const binaryDirectory = join(temp, 'bin');
  const rootDirectory = join(temp, 'instance');
  await mkdir(binaryDirectory);
  await writeFile(postgresBinary(binaryDirectory, 'postgres'), '');
  await writeFile(postgresBinary(binaryDirectory, 'initdb'), '');
  privateDir(rootDirectory);
  return { temp, binaryDirectory, rootDirectory };
}

function fakeProcess(pidFile?: string) {
  let exitCode: number | null = null;
  const exits: Array<() => void> = [];
  return {
    pid: 4242,
    get exitCode() {
      return exitCode;
    },
    kill() {
      if (exitCode !== null) return false;
      exitCode = 0;
      if (pidFile) rmSync(pidFile, { force: true });
      for (const exit of exits) exit();
      return true;
    },
    once(event: string, listener: () => void) {
      if (event === 'exit') exits.push(listener);
      return this;
    },
  };
}

// Like PostgreSQL, a started fake server records postmaster.pid (pid, data
// directory) and removes it when it stops. Windows stops it through pg_ctl
// after matching that record, so the fake pg_ctl stops the server it names.
const runningServers = new Map<string, ReturnType<typeof fakeProcess>>();
function startedServer(dataDirectory: string) {
  const pidFile = join(dataDirectory, 'postmaster.pid');
  writeFileSync(pidFile, `4242\n${dataDirectory}\n`);
  const server = fakeProcess(pidFile);
  runningServers.set(dataDirectory, server);
  return server;
}

class FakePool {
  constructor(_config: object) {}
  async query(sql: string) {
    if (sql.includes('pg_roles')) return { rows: [{ rolsuper: false, rolbypassrls: false }], rowCount: 1 };
    if (sql.includes('pg_database')) return { rows: [], rowCount: 0 };
    if (sql.includes('schema_migrations') && sql.includes('SELECT')) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 1 };
  }
  async connect() {
    return { query: this.query.bind(this), release() {} };
  }
  async end() {}
}

function createExecute(calls: string[][]) {
  return async (file: string, args: readonly string[], options: { env: NodeJS.ProcessEnv }) => {
    expect(options.env.PGPASSWORD).toBeUndefined();
    expect(options.env.PGUSER).toBeUndefined();
    calls.push([file, ...args]);
    if (args.includes('--version')) return { stdout: 'postgres (PostgreSQL) 16.4', stderr: '' };
    if (basename(file).startsWith('pg_ctl')) {
      runningServers.get(args[args.indexOf('-D') + 1])?.kill();
      return { stdout: '', stderr: '' };
    }
    if (basename(file).startsWith('initdb')) {
      const data = args[args.indexOf('-D') + 1];
      await mkdir(data, { recursive: true });
      await writeFile(join(data, 'PG_VERSION'), '16\n');
      await writeFile(join(data, 'postgresql.conf'), '# initdb\n');
      await writeFile(join(data, 'pg_hba.conf'), 'host all all 127.0.0.1/32 trust\n');
      return { stdout: '', stderr: '' };
    }
    throw new Error(`unexpected ${basename(file)}`);
  };
}

function hooks(calls: string[][], spawnEnv?: { current?: NodeJS.ProcessEnv }) {
  return {
    execute: createExecute(calls),
    spawnServer: (file: string, args: readonly string[], env: NodeJS.ProcessEnv) => {
      expect(basename(file).startsWith('postgres')).toBe(true);
      expect(args).toEqual(['-D', expect.any(String)]);
      // Paths may legitimately contain "-o". Reject the option as an argv
      // entry without confusing a randomly generated directory with a flag.
      expect(args.some(arg => /^-o(?:$|[^/\\])/.test(arg))).toBe(false);
      expect(env.PGPASSWORD).toBeUndefined();
      if (spawnEnv) spawnEnv.current = env;
      return startedServer(args[1]);
    },
    Pool: FakePool,
  };
}

describe('postgresBinary', () => {
  it('plans unix and windows executables without pretending an install exists', () => {
    expect(postgresBinary('/opt/homebrew/bin', 'postgres', 'darwin')).toBe('/opt/homebrew/bin/postgres');
    expect(postgresBinary('/opt/homebrew/bin/', 'initdb', 'linux')).toBe('/opt/homebrew/bin/initdb');
    expect(postgresBinary('C:\\Program Files\\PostgreSQL\\16\\bin', 'postgres', 'win32')).toBe(
      'C:\\Program Files\\PostgreSQL\\16\\bin\\postgres.exe',
    );
    expect(postgresBinary('C:\\Program Files\\PostgreSQL\\16\\bin', 'postgres.exe', 'win32')).toBe(
      'C:\\Program Files\\PostgreSQL\\16\\bin\\postgres.exe',
    );
  });
});

describe('openOwnedPostgres', () => {
  it.each(['privileged-token', 'verification-unavailable'] as const)('refuses %s before creating a root, lock, credentials or invoking initdb', async reason => {
    const temp = await mkdtemp(join(tmpdir(), 'rb-host-pg-admission-')); temps.push(temp);
    const rootDirectory = join(temp, 'never-created');
    const execute = vi.fn(), spawnServer = vi.fn();
    const failure = new WindowsPostgresAdmissionError(reason);
    vi.mocked(assertWindowsPostgresAdmission).mockRejectedValue(failure);
    await expect(openOwnedPostgres({ rootDirectory, binaryDirectory: join(temp, 'never-inspected'), port: 5432 }, { execute, spawnServer }))
      .rejects.toBe(failure);
    expect(await readdir(temp)).toEqual([]);
    expect(execute).not.toHaveBeenCalled(); expect(spawnServer).not.toHaveBeenCalled();
  });

  it('preserves every existing state file when launch admission is refused', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'rb-host-pg-preserved-')); temps.push(temp);
    const state = { 'owner.lock': 'fictional-owned-lock', 'ownership.json': 'fictional-owned-manifest', 'setup-progress.json': 'fictional-progress' };
    for (const [name, contents] of Object.entries(state)) await writeFile(join(temp, name), contents);
    const execute = vi.fn(), spawnServer = vi.fn();
    vi.mocked(assertWindowsPostgresAdmission).mockRejectedValue(new WindowsPostgresAdmissionError('privileged-token'));
    await expect(openOwnedPostgres({ rootDirectory: temp, binaryDirectory: join(temp, 'absent-bin'), port: 5432 }, { execute, spawnServer }))
      .rejects.toBeInstanceOf(WindowsPostgresAdmissionError);
    expect((await readdir(temp)).sort()).toEqual(Object.keys(state).sort());
    for (const [name, contents] of Object.entries(state)) expect(await readFile(join(temp, name), 'utf8')).toBe(contents);
    expect(execute).not.toHaveBeenCalled(); expect(spawnServer).not.toHaveBeenCalled();
  });

  it('rechecks cancellation after admission before touching the filesystem', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'rb-host-pg-admission-abort-')); temps.push(temp);
    const controller = new AbortController();
    vi.mocked(assertWindowsPostgresAdmission).mockImplementation(async signal => { expect(signal).toBe(controller.signal); controller.abort(); });
    const execute = vi.fn();
    await expect(openOwnedPostgres({ rootDirectory: join(temp, 'absent'), binaryDirectory: 'absent-bin', port: 5432, signal: controller.signal }, { execute }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(await readdir(temp)).toEqual([]); expect(execute).not.toHaveBeenCalled();
  });

  it('preserves unrelated files and refuses to adopt their directory', async () => {
    const { binaryDirectory, rootDirectory } = await workspace();
    await writeFile(join(rootDirectory, 'keep.txt'), 'unrelated');
    await expect(openOwnedPostgres({ rootDirectory, binaryDirectory, port: await freePort() }, hooks([]))).rejects.toThrow('unowned nonempty');
    expect(await readFile(join(rootDirectory, 'keep.txt'), 'utf8')).toBe('unrelated');
    expect(await exists(join(rootDirectory, 'credentials'))).toBe(false);
  });

  it('preserves initialized data after cancellation and holds incomplete setup for recovery', async () => {
    const { binaryDirectory, rootDirectory } = await workspace();
    const controller = new AbortController();
    const dependencies = hooks([]);
    const execute = dependencies.execute;
    dependencies.execute = async (file, args, options) => {
      const result = await execute(file, args, options);
      if (basename(file).startsWith('initdb')) controller.abort();
      return result;
    };
    await expect(openOwnedPostgres({ rootDirectory, binaryDirectory, port: await freePort(), signal: controller.signal }, dependencies)).rejects.toMatchObject({ name: 'AbortError' });
    expect(await exists(join(rootDirectory, 'data', 'PG_VERSION'))).toBe(true);
    expect(await exists(join(rootDirectory, 'owner.lock'))).toBe(false);
    await expect(openOwnedPostgres({ rootDirectory, binaryDirectory, port: await freePort() }, hooks([]))).rejects.toThrow('setup is incomplete');
  });
  it('rejects an already aborted signal before touching binaries', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      openOwnedPostgres({ rootDirectory: 'root', binaryDirectory: 'bin', port: 5432, signal: controller.signal }),
    ).rejects.toThrow(/aborted/);
  });

  it('refuses an occupied loopback port', async () => {
    const { binaryDirectory, rootDirectory } = await workspace();
    const server = createServer();
    const port = await new Promise<number>((resolve, reject) => {
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
        const address = server.address();
        if (typeof address === 'object' && address) resolve(address.port);
        else reject(new Error('no port'));
      });
      server.once('error', reject);
    });
    try {
      await expect(openOwnedPostgres({ rootDirectory, binaryDirectory, port })).rejects.toThrow(/occupied/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('requires operator recovery for a stale wx lock and never treats PID as safety', async () => {
    const { binaryDirectory, rootDirectory } = await workspace();
    await writeFile(join(rootDirectory, 'owner.lock'), JSON.stringify({ pid: 1 }));
    const calls: string[][] = [];
    await expect(openOwnedPostgres({ rootDirectory, binaryDirectory, port: await freePort() }, hooks(calls))).rejects.toThrow(
      /Operator recovery.*never treated as safe by PID/s,
    );
  });

  it('refuses a symbolic-link root', async () => {
    const { binaryDirectory, rootDirectory, temp } = await workspace();
    const linked = join(temp, 'linked-root');
    await symlink(rootDirectory, linked);
    await expect(openOwnedPostgres({ rootDirectory: linked, binaryDirectory, port: await freePort() }, hooks([]))).rejects.toThrow(
      /symbolic link/,
    );
  });

  it('fails closed on unfinished setup and unrelated data directories', async () => {
    const { binaryDirectory, rootDirectory } = await workspace();
    await mkdir(join(rootDirectory, 'data'));
    await writeFile(join(rootDirectory, 'data', 'PG_VERSION'), '16\n');
    await writeFile(join(rootDirectory, 'setup-progress.json'), JSON.stringify({ schemaVersion: 1, phase: 'initdb' }));
    await expect(openOwnedPostgres({ rootDirectory, binaryDirectory, port: await freePort() }, hooks([]))).rejects.toThrow(
      /will not be wiped|[Nn]ot be adopted|Operator recovery/,
    );
  });

  it('rejects a trusted binary that is not PostgreSQL 16', async () => {
    const { binaryDirectory, rootDirectory } = await workspace();
    await expect(
      openOwnedPostgres(
        { rootDirectory, binaryDirectory, port: await freePort() },
        {
          execute: async () => ({ stdout: 'postgres (PostgreSQL) 15.10', stderr: '' }),
          spawnServer: () => fakeProcess(),
          Pool: FakePool,
        },
      ),
    ).rejects.toThrow(/PostgreSQL 16/);
  });

  it('refuses leftover postmaster.pid instead of adopting it', async () => {
    const { binaryDirectory, rootDirectory } = await workspace();
    await mkdir(join(rootDirectory, 'data'));
    await writeFile(join(rootDirectory, 'data', 'postmaster.pid'), '99\n');
    await expect(openOwnedPostgres({ rootDirectory, binaryDirectory, port: await freePort() }, hooks([]))).rejects.toThrow(
      /never adopts an unowned postmaster/,
    );
  });

  it('first-boots with argv execFile, static conf, scram hba, then reopens the same data', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'rb-host-pg-space-'));
    temps.push(temp);
    const binaryDirectory = join(temp, 'pg bin');
    const rootDirectory = join(temp, 'instance');
    await mkdir(binaryDirectory);
    await writeFile(postgresBinary(binaryDirectory, 'postgres'), '');
    await writeFile(postgresBinary(binaryDirectory, 'initdb'), '');
    privateDir(rootDirectory);
    const calls: string[][] = [];
    const spawnEnv: { current?: NodeJS.ProcessEnv } = {};
    process.env.PGPASSWORD = 'parent-should-not-leak';
    const port = await freePort();
    try {
      const handle = await openOwnedPostgres({ rootDirectory, binaryDirectory, port }, hooks(calls, spawnEnv));
      expect(handle.version).toContain('16.4');
      expect(handle.adminUrl).toContain('127.0.0.1');
      expect(handle.applicationUrl).toContain('realbud_company');
      expect(handle.applicationUrl).not.toContain('realbud_admin');
      const initdb = calls.find((call) => basename(call[0]).startsWith('initdb'));
      expect(initdb?.[0]).toContain('pg bin');
      expect(initdb).toEqual(
        expect.arrayContaining(['-D', join(rootDirectory, 'data'), '--auth-local=scram-sha-256', '--auth-host=scram-sha-256']),
      );
      expect(initdb?.some((arg) => arg.startsWith('--pwfile='))).toBe(true);
      expect(initdb?.join('\0')).not.toMatch(/(^|\0)trust(\0|$)/);
      expect(calls[0]?.[0]).toContain('pg bin');
      const conf = await readFile(join(rootDirectory, 'data', 'postgresql.conf'), 'utf8');
      expect(conf).toContain("listen_addresses = '127.0.0.1'");
      expect(conf).toContain('password_encryption = scram-sha-256');
      expect(conf).toContain(`port = ${port}`);
      const hba = await readFile(join(rootDirectory, 'data', 'pg_hba.conf'), 'utf8');
      expect(hba).toContain('scram-sha-256');
      expect(hba).not.toMatch(/\btrust\b/);
      expect(spawnEnv.current?.PGPASSWORD).toBeUndefined();
      await handle.stop();
      expect(await exists(join(rootDirectory, 'owner.lock'))).toBe(false);
      expect(await readFile(join(rootDirectory, 'data', 'PG_VERSION'), 'utf8')).toContain('16');
      expect(await exists(join(rootDirectory, 'ownership.json'))).toBe(true);
      const before = calls.filter((call) => basename(call[0]).startsWith('initdb')).length;
      const reopened = await openOwnedPostgres({ rootDirectory, binaryDirectory, port }, hooks(calls, spawnEnv));
      expect(calls.filter((call) => basename(call[0]).startsWith('initdb')).length).toBe(before);
      await reopened.stop();
      await expect(openOwnedPostgres({ rootDirectory, binaryDirectory, port: port + 1 }, hooks([]))).rejects.toThrow(
        /port must remain matching/,
      );
      await expect(
        openOwnedPostgres({ rootDirectory, binaryDirectory: join(temp, 'other-bin'), port }, hooks([])),
      ).rejects.toThrow(/binaryDirectory|binary directory/);
    } finally {
      delete process.env.PGPASSWORD;
    }
  });

  it('redacts credentials on failure and never wipes the data directory', async () => {
    const { binaryDirectory, rootDirectory } = await workspace();
    class BoomPool {
      constructor(_config: object) {}
      async query(): Promise<never> {
        throw new Error(
          'password=should-not-leak-xyz postgresql://realbud_admin:should-not-leak-xyz@127.0.0.1/postgres',
        );
      }
      async connect() {
        return { query: this.query.bind(this), release() {} };
      }
      async end() {}
    }
    const error = await openOwnedPostgres(
      { rootDirectory, binaryDirectory, port: await freePort() },
      { execute: createExecute([]), spawnServer: (_file, args) => startedServer(args[1]), Pool: BoomPool },
    ).catch((caught: unknown) => caught as Error);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error('Expected failed startup');
    expect(error.message).not.toContain('should-not-leak-xyz');
    expect(error.message).not.toMatch(/postgresql:\/\/\S+/i);
    expect(await readFile(join(rootDirectory, 'data', 'PG_VERSION'), 'utf8')).toContain('16');
    expect(await exists(join(rootDirectory, 'owner.lock'))).toBe(false);
    expect(await exists(join(rootDirectory, 'ownership.json'))).toBe(false);
  });
});
