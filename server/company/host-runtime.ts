import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { access, lstat, mkdir, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { migrateCompanySchema } from './schema.ts';
import { windowsFilePrivacy } from '../windows-file-privacy.ts';
import { assertWindowsPostgresAdmission } from '../windows-postgres-admission.ts';

const execFileAsync = promisify(execFile);
const MANIFEST_KIND = 'realbud-owned-postgres';
const APPLICATION_DATABASE = 'realbud_company';
const ADMIN_ROLE = 'realbud_admin';
const APPLICATION_ROLE = 'realbud_app';
const DATA_DIR_NAME = 'data';
const VERSION_TIMEOUT_MS = 15_000;
const INITDB_TIMEOUT_MS = 60_000;
const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 15_000;
const MANIFEST_KEYS = [
  'schemaVersion',
  'kind',
  'postgresqlMajor',
  'postgresVersion',
  'binaryDirectory',
  'port',
  'listenAddress',
  'database',
  'adminRole',
  'applicationRole',
  'dataDirectory',
  'initializedAt',
] as const;

export type OwnedPostgresHandle = {
  adminUrl: string;
  applicationUrl: string;
  version: string;
  stop: () => Promise<void>;
};

export type OwnedPostgresProcess = {
  readonly pid?: number;
  readonly exitCode: number | null;
  readonly signalCode?: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: 'exit' | 'error', listener: (arg?: unknown) => void): unknown;
};

export type OwnedPostgresDependencies = {
  execute?: (
    file: string,
    args: readonly string[],
    options: { timeout: number; signal?: AbortSignal; env: NodeJS.ProcessEnv },
  ) => Promise<{ stdout: string; stderr: string }>;
  spawnServer?: (file: string, args: readonly string[], env: NodeJS.ProcessEnv) => OwnedPostgresProcess;
  Pool?: new (config: object) => {
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount?: number | null }>;
    connect(): Promise<{
      query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount?: number | null }>;
      release(): void;
    }>;
    end(): Promise<void>;
  };
};

type Manifest = {
  schemaVersion: 1;
  kind: typeof MANIFEST_KIND;
  postgresqlMajor: 16;
  postgresVersion: string;
  binaryDirectory: string;
  port: number;
  listenAddress: '127.0.0.1';
  database: typeof APPLICATION_DATABASE;
  adminRole: typeof ADMIN_ROLE;
  applicationRole: typeof APPLICATION_ROLE;
  dataDirectory: typeof DATA_DIR_NAME;
  initializedAt: string;
};

export function postgresBinary(directory: string, name: string, platform = process.platform): string {
  const executable = platform === 'win32' && !name.toLowerCase().endsWith('.exe') ? `${name}.exe` : name;
  const separator = platform === 'win32' ? '\\' : '/';
  const root = directory.endsWith('\\') || directory.endsWith('/') ? directory.slice(0, -1) : directory;
  return `${root}${separator}${executable}`;
}

function childEnvironment(): NodeJS.ProcessEnv {
  // GUI launches on macOS need not supply a locale. PostgreSQL may otherwise
  // initialize Foundation threads and refuse startup before accepting a client.
  // initdb already uses --no-locale; C is available on both target platforms.
  const env: NodeJS.ProcessEnv = { LC_ALL: 'C', LANG: 'C' };
  for (const key of ['PATH', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'TZ', 'HOME', 'USERPROFILE']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function abortError(): Error {
  const error = new Error('Owned PostgreSQL start was aborted');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function connectionUrl(user: string, password: string, port: number, database: string): string {
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}`;
}

function redact(text: string, secrets: readonly string[]): string {
  let out = text.replace(/postgresql:\/\/\S+/gi, '[database connection redacted]');
  out = out.replace(/(password)\s*[=:]\s*\S+/gi, '$1=[redacted]');
  for (const secret of secrets) {
    if (secret.length >= 8) out = out.split(secret).join('[redacted]');
  }
  return out;
}

function safeError(error: unknown, fallback: string, secrets: readonly string[] = []): Error {
  if (error instanceof Error && error.name === 'AbortError') return error;
  const raw = error instanceof Error ? error.message : fallback;
  const result = new Error(redact(raw || fallback, secrets) || fallback);
  result.name = error instanceof Error ? error.name : 'Error';
  return result;
}

function recovery(message: string): Error {
  return new Error(message);
}

async function defaultExecute(
  file: string,
  args: readonly string[],
  options: { timeout: number; signal?: AbortSignal; env: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(file, [...args], {
      timeout: options.timeout,
      signal: options.signal,
      env: options.env,
      windowsHide: true,
      maxBuffer: 2_000_000,
      encoding: 'utf8',
    });
    return { stdout: String(result.stdout), stderr: String(result.stderr) };
  } catch (error) {
    if ((error instanceof Error && error.name === 'AbortError') || options.signal?.aborted) throw abortError();
    throw new Error(`Owned PostgreSQL failed running ${basename(file)}`);
  }
}

function defaultSpawn(file: string, args: readonly string[], env: NodeJS.ProcessEnv): OwnedPostgresProcess {
  return spawn(file, [...args], { env, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true, detached: false });
}

async function assertNotSymlink(path: string, label: string, required: boolean): Promise<void> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) throw new Error(`${label} cannot be a symbolic link`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (required) throw new Error(`${label} is missing`);
      return;
    }
    throw error;
  }
}

async function assertTrustedBinary(path: string, label: string): Promise<void> {
  let stats;
  try {
    stats = await lstat(path);
  } catch {
    throw new Error(`Trusted ${label} binary is missing. Owned PostgreSQL does not search PATH or download PostgreSQL.`);
  }
  if (stats.isSymbolicLink()) throw new Error(`Trusted ${label} binary cannot be a symbolic link`);
  if (!stats.isFile()) throw new Error(`Trusted ${label} path is not a file`);
}

function assertPortFree(port: number): Promise<void> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        reject(new Error(`Port ${port} is occupied; owned PostgreSQL will not bind or adopt an in-use address`));
        return;
      }
      reject(error);
    });
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.close((closeError) => (closeError ? reject(closeError) : resolvePort()));
    });
  });
}

function assertPostgres16(stdout: string): string {
  const version = stdout.trim();
  if (!/PostgreSQL\) 16\.\d+/.test(version)) {
    throw new Error(
      'Owned PostgreSQL requires a trusted PostgreSQL 16 binary (postgres --version). This runtime does not download, install, or discover another database.',
    );
  }
  return version;
}

function parseManifest(text: string): Manifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw recovery(
      'Owned PostgreSQL ownership manifest is not valid JSON. Operator recovery: inspect the RealBud root and restore a consistent manifest. Data was not modified.',
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw recovery('Owned PostgreSQL ownership manifest is invalid. Operator recovery required.');
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== MANIFEST_KEYS.length || MANIFEST_KEYS.some((key) => !keys.includes(key))) {
    throw recovery('Owned PostgreSQL ownership manifest failed strict field validation. Operator recovery required.');
  }
  if (
    record.schemaVersion !== 1 ||
    record.kind !== MANIFEST_KIND ||
    record.postgresqlMajor !== 16 ||
    typeof record.postgresVersion !== 'string' ||
    !/PostgreSQL\) 16\.\d+/.test(record.postgresVersion) ||
    typeof record.binaryDirectory !== 'string' ||
    !Number.isInteger(record.port) ||
    (record.port as number) < 1 ||
    (record.port as number) > 65535 ||
    record.listenAddress !== '127.0.0.1' ||
    record.database !== APPLICATION_DATABASE ||
    record.adminRole !== ADMIN_ROLE ||
    record.applicationRole !== APPLICATION_ROLE ||
    record.dataDirectory !== DATA_DIR_NAME ||
    typeof record.initializedAt !== 'string' ||
    Number.isNaN(Date.parse(record.initializedAt))
  ) {
    throw recovery('Owned PostgreSQL ownership manifest failed strict value validation. Operator recovery required.');
  }
  return record as Manifest;
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try { await windowsFilePrivacy(temporary, 'file', true); await rename(temporary, path); } finally { await unlink(temporary).catch(() => {}); }
}

async function writeProgress(path: string, phase: string): Promise<void> {
  await writeAtomic(
    path,
    JSON.stringify({ schemaVersion: 1, kind: 'realbud-owned-postgres-progress', phase, updatedAt: new Date().toISOString() }),
  );
}

function confSnippet(port: number): string {
  return [
    '',
    '# realbud-owned-postgres',
    "listen_addresses = '127.0.0.1'",
    `port = ${port}`,
    'password_encryption = scram-sha-256',
    "unix_socket_directories = ''",
    'logging_collector = on',
    "log_destination = 'stderr'",
    '',
  ].join('\n');
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function waitForExit(child: OwnedPostgresProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode || !child.pid) return Promise.resolve();
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => reject(new Error('Owned PostgreSQL stop timed out')), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
}

export async function stopOwnedPostgresProcess(child: OwnedPostgresProcess, options: {
  binaryDirectory: string; dataDirectory: string; platform?: NodeJS.Platform;
  execute?: OwnedPostgresDependencies['execute'];
}): Promise<void> {
  if (child.exitCode !== null || child.signalCode || !child.pid) return;
  if ((options.platform ?? process.platform) === 'win32') {
    // Node emulates SIGINT/SIGTERM as termination on Windows. pg_ctl uses
    // PostgreSQL's native shutdown protocol. Verify this handle still owns it.
    const marker = join(options.dataDirectory, 'postmaster.pid');
    await assertNotSymlink(marker, 'Owned PostgreSQL process marker', true);
    const lines = (await readFile(marker, 'utf8')).split(/\r?\n/);
    if (Number(lines[0]) !== child.pid || !samePath(lines[1] ?? '', options.dataDirectory)) throw recovery('Owned PostgreSQL process identity changed; data preserved for recovery.');
    await (options.execute ?? defaultExecute)(postgresBinary(options.binaryDirectory, 'pg_ctl', 'win32'),
      ['-D', options.dataDirectory, '-m', 'fast', '-w', '-t', '10', 'stop'], { timeout: 12_000, env: childEnvironment() });
    await waitForExit(child, 3_000);
    return;
  }
  child.kill('SIGINT');
  try {
    await waitForExit(child, STOP_TIMEOUT_MS);
  } catch {
    child.kill('SIGKILL');
    await waitForExit(child, 5_000);
  }
}

async function readPassword(path: string, label: string): Promise<string> {
  await assertNotSymlink(path, `Owned PostgreSQL ${label} credential`, true);
  const state = await lstat(path);
  if (!state.isFile() || state.nlink !== 1 || state.size > 256 || (process.platform !== 'win32' && ((state.mode & 0o077) !== 0 || state.uid !== process.getuid?.()))) throw recovery('Owned PostgreSQL credentials need private service-owned files.');
  await windowsFilePrivacy(path, 'file');
  let text: string;
  try {
    text = (await readFile(path, 'utf8')).trim();
  } catch {
    throw recovery(`Owned PostgreSQL ${label} credential file is missing. Operator recovery required. Data was not deleted.`);
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(text)) throw recovery(`Owned PostgreSQL ${label} credential file is invalid. Operator recovery required.`);
  return text;
}

async function unfinishedError(progressPath: string, extra: string): Promise<Error> {
  let phase = 'unknown';
  try {
    const progress = JSON.parse(await readFile(progressPath, 'utf8')) as { phase?: string };
    if (typeof progress.phase === 'string') phase = progress.phase;
  } catch {
    phase = 'unreadable';
  }
  return recovery(
    `Owned PostgreSQL setup is incomplete (phase: ${phase}). ${extra} Data and configuration were preserved and will not be wiped. Operator recovery: inspect this RealBud root, repair the instance, and only retry after the ownership manifest is consistent. Do not delete the data directory unless you intend to destroy this instance. Do not infer lock safety from PID files.`,
  );
}

export async function openOwnedPostgres(
  options: { rootDirectory: string; binaryDirectory: string; port: number; signal?: AbortSignal },
  dependencies: OwnedPostgresDependencies = {},
): Promise<OwnedPostgresHandle> {
  throwIfAborted(options.signal);
  if (!options.rootDirectory || !options.binaryDirectory) {
    throw new Error('Owned PostgreSQL requires an explicit trusted rootDirectory and binaryDirectory');
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error('Owned PostgreSQL port must be an integer from 1 to 65535');
  }
  await assertWindowsPostgresAdmission(options.signal);
  throwIfAborted(options.signal);

  const root = resolve(options.rootDirectory);
  const binaries = resolve(options.binaryDirectory);
  const port = options.port;
  const signal = options.signal;
  const execute = dependencies.execute ?? defaultExecute;
  const spawnServer = dependencies.spawnServer ?? defaultSpawn;
  const PoolCtor = dependencies.Pool ?? Pool;
  const env = childEnvironment();
  const secrets: string[] = [];
  const postgres = postgresBinary(binaries, 'postgres');
  const initdb = postgresBinary(binaries, 'initdb');
  const lockPath = join(root, 'owner.lock');
  const manifestPath = join(root, 'ownership.json');
  const progressPath = join(root, 'setup-progress.json');
  const dataDir = join(root, DATA_DIR_NAME);
  const credentialDir = join(root, 'credentials');
  const adminSecretPath = join(credentialDir, 'admin');
  const appSecretPath = join(credentialDir, 'application');

  await assertNotSymlink(root, 'Owned PostgreSQL rootDirectory', false);
  await assertNotSymlink(binaries, 'Owned PostgreSQL binaryDirectory', true);
  await assertPortFree(port);
  await assertTrustedBinary(postgres, 'postgres');
  await assertTrustedBinary(initdb, 'initdb');
  throwIfAborted(signal);

  const version = assertPostgres16(
    (await execute(postgres, ['--version'], { timeout: VERSION_TIMEOUT_MS, signal, env })).stdout,
  );

  const createdRoot = await mkdir(root, { recursive: true, mode: 0o700 });
  await assertNotSymlink(root, 'Owned PostgreSQL rootDirectory', true);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || (process.platform !== 'win32' && ((rootStat.mode & 0o077) !== 0 || rootStat.uid !== process.getuid?.()))) throw recovery('Owned PostgreSQL root must be a private service-owned directory.');
  await windowsFilePrivacy(root, 'directory', createdRoot !== undefined);

  let lockHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    lockHandle = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw recovery(
        'Owned PostgreSQL lock is already present. Operator recovery required: confirm no RealBud host is using this root, then remove only the owned lock file. Stale locks are never treated as safe by PID.',
      );
    }
    throw error;
  }
  let child: OwnedPostgresProcess | undefined;
  const stopProcess = (owned: OwnedPostgresProcess) => stopOwnedPostgresProcess(owned, { binaryDirectory: binaries, dataDirectory: dataDir, execute });

  const releaseLock = async () => {
    if (!lockHandle) return;
    await lockHandle.close().catch(() => undefined);
    lockHandle = undefined;
    await unlink(lockPath).catch(() => undefined);
  };

  const stopOwned = async (removeLock: boolean) => {
    if (child && child.exitCode === null) await stopProcess(child);
    child = undefined;
    if (removeLock) await releaseLock();
  };

  try {
    await lockHandle.writeFile(JSON.stringify({ kind: 'realbud-owned-postgres-lock', pid: process.pid, createdAt: new Date().toISOString() }));
    throwIfAborted(signal);
    await assertNotSymlink(dataDir, 'Owned PostgreSQL data directory', false);
    for (const path of [manifestPath, progressPath, credentialDir]) await assertNotSymlink(path, 'Owned PostgreSQL state', false);
    const manifestExists = await pathExists(manifestPath);
    const progressExists = await pathExists(progressPath);
    const dataExists = await pathExists(join(dataDir, 'PG_VERSION'));
    if (await pathExists(join(dataDir, 'postmaster.pid'))) {
      throw recovery(
        'Owned PostgreSQL refuses to adopt a running or leftover postmaster.pid. Operator recovery: stop any process using this data directory, then retry. This runtime never adopts an unowned postmaster.',
      );
    }

    let adminPassword: string;
    let applicationPassword: string;
    let firstBoot = false;

    if (manifestExists) {
      const manifest = parseManifest(await readFile(manifestPath, 'utf8'));
      if (manifest.port !== port) {
        throw recovery('Owned PostgreSQL port must remain matching the ownership manifest. Operator recovery required.');
      }
      if (!samePath(manifest.binaryDirectory, binaries)) {
        throw recovery('Owned PostgreSQL must bind the same trusted binary directory recorded in the ownership manifest.');
      }
      if (progressExists) await unlink(progressPath).catch(() => undefined);
      if (!dataExists) {
        throw recovery('Owned PostgreSQL ownership manifest exists but the data directory is missing. Operator recovery required.');
      }
      adminPassword = await readPassword(adminSecretPath, 'admin');
      applicationPassword = await readPassword(appSecretPath, 'application');
      secrets.push(adminPassword, applicationPassword);
    } else {
      if (progressExists || dataExists) {
        throw await unfinishedError(
          progressPath,
          dataExists
            ? 'An unrelated or unfinished data directory is present and will not be adopted.'
            : 'Setup progress was persisted without a complete ownership manifest.',
        );
      }
      if ((await readdir(root)).some(name => name !== 'owner.lock')) throw recovery('Owned PostgreSQL refuses an unowned nonempty directory. Existing files were preserved.');
      firstBoot = true;
      adminPassword = randomBytes(32).toString('base64url');
      applicationPassword = randomBytes(32).toString('base64url');
      secrets.push(adminPassword, applicationPassword);
      const createdCredentials = await mkdir(credentialDir, { recursive: true, mode: 0o700 });
      await windowsFilePrivacy(credentialDir, 'directory', createdCredentials !== undefined);
      await writeProgress(progressPath, 'credentials');
      await writeFile(adminSecretPath, adminPassword, { mode: 0o600, flag: 'wx' });
      await windowsFilePrivacy(adminSecretPath, 'file', true);
      await writeFile(appSecretPath, applicationPassword, { mode: 0o600, flag: 'wx' });
      await windowsFilePrivacy(appSecretPath, 'file', true);
      const pwfile = join(root, 'initdb-pwfile');
      await writeFile(pwfile, `${adminPassword}\n`, { mode: 0o600, flag: 'wx' });
      await windowsFilePrivacy(pwfile, 'file', true);
      try {
        await writeProgress(progressPath, 'initdb');
        await execute(
          initdb,
          [
            '-D',
            dataDir,
            '-U',
            ADMIN_ROLE,
            `--pwfile=${pwfile}`,
            '--auth-local=scram-sha-256',
            '--auth-host=scram-sha-256',
            '--encoding=UTF8',
            '--no-locale',
          ],
          { timeout: INITDB_TIMEOUT_MS, signal, env },
        );
      } finally {
        await unlink(pwfile).catch(() => undefined);
      }
      await assertNotSymlink(dataDir, 'Owned PostgreSQL data directory', true);
      const postgresqlConf = join(dataDir, 'postgresql.conf');
      await writeFile(postgresqlConf, confSnippet(port), { encoding: 'utf8' });
      await writeFile(join(dataDir, 'pg_hba.conf'), '# RealBud owned native PostgreSQL. SCRAM only.\nhost all all 127.0.0.1/32 scram-sha-256\n', {
        encoding: 'utf8',
      });
      await writeProgress(progressPath, 'configured');
    }

    throwIfAborted(signal);
    // Check these before starting the process, including on restart.
    for (const file of ['postgresql.conf', 'pg_hba.conf', 'PG_VERSION']) await assertNotSymlink(join(dataDir, file), 'Owned PostgreSQL configuration', true);
    if ((await readFile(join(dataDir, 'PG_VERSION'), 'utf8')).trim() !== '16' ||
      (await readFile(join(dataDir, 'postgresql.conf'), 'utf8')) !== confSnippet(port) ||
      (await readFile(join(dataDir, 'pg_hba.conf'), 'utf8')).split('\n').filter(line => line.trim() && !line.trim().startsWith('#')).join('\n') !== 'host all all 127.0.0.1/32 scram-sha-256') throw recovery('Owned PostgreSQL configuration changed; operator recovery required before restart.');
    const autoConf = join(dataDir, 'postgresql.auto.conf');
    await assertNotSymlink(autoConf, 'Owned PostgreSQL automatic configuration', false);
    if (await pathExists(autoConf)) {
      const settings = (await readFile(autoConf, 'utf8')).split('\n').filter(line => line.trim() && !line.trim().startsWith('#'));
      if (settings.length) throw recovery('Owned PostgreSQL automatic configuration changed; operator recovery required.');
    }
    child = spawnServer(postgres, ['-D', dataDir], env);
    let spawnFailure: Error | undefined;
    child.once('error', (arg) => {
      spawnFailure = arg instanceof Error ? arg : new Error('Owned PostgreSQL process failed to spawn');
    });
    child.once('exit', () => {
      if (child && child.exitCode !== 0 && child.exitCode !== null) {
        spawnFailure = spawnFailure ?? new Error('Owned PostgreSQL process exited before becoming ready');
      }
    });

    const adminConfig = {
      host: '127.0.0.1',
      port,
      user: ADMIN_ROLE,
      password: adminPassword,
      database: 'postgres',
      ssl: false,
      max: 1,
      connectionTimeoutMillis: 2000,
    };
    const deadline = Date.now() + START_TIMEOUT_MS;
    let ready = false;
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      if (spawnFailure) throw spawnFailure;
      const candidate = new PoolCtor(adminConfig);
      try {
        await candidate.query('SELECT 1');
        await candidate.end().catch(() => undefined);
        ready = true;
        break;
      } catch (error) {
        await candidate.end().catch(() => undefined);
        const message = error instanceof Error ? error.message : '';
        const transient = /ECONNREFUSED|ETIMEDOUT|ECONNRESET|timeout|starting up|not accepting connections/i.test(message);
        if (!transient && message) throw error;
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      }
    }
    if (!ready) throw new Error('Owned PostgreSQL did not become ready in time');

    if (firstBoot) {
      await writeProgress(progressPath, 'bootstrapped');
      const adminPool = new PoolCtor({ ...adminConfig, database: 'postgres', max: 2 });
      try {
        const databases = await adminPool.query('SELECT 1 FROM pg_database WHERE datname = $1', [APPLICATION_DATABASE]);
        if (!databases.rows.length) {
          await adminPool.query(`CREATE DATABASE ${APPLICATION_DATABASE} OWNER ${ADMIN_ROLE} TEMPLATE template0 ENCODING 'UTF8'`);
        }
        await adminPool.query(`REVOKE ALL ON DATABASE ${APPLICATION_DATABASE} FROM PUBLIC`);
        const roles = await adminPool.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [APPLICATION_ROLE]);
        if (!roles.rows.length) {
          await adminPool.query(
            `CREATE ROLE ${APPLICATION_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD ${sqlLiteral(applicationPassword)}`,
          );
        }
        await adminPool.query(`GRANT CONNECT ON DATABASE ${APPLICATION_DATABASE} TO ${APPLICATION_ROLE}`);
      } finally {
        await adminPool.end();
      }
    }
      const companyPool = new PoolCtor({ ...adminConfig, database: APPLICATION_DATABASE, max: 2 });
      try {
        await migrateCompanySchema(companyPool as Pool, { applicationRole: APPLICATION_ROLE });
      } finally {
        await companyPool.end();
      }
    if (firstBoot) {
      const manifest: Manifest = {
        schemaVersion: 1,
        kind: MANIFEST_KIND,
        postgresqlMajor: 16,
        postgresVersion: version,
        binaryDirectory: binaries,
        port,
        listenAddress: '127.0.0.1',
        database: APPLICATION_DATABASE,
        adminRole: ADMIN_ROLE,
        applicationRole: APPLICATION_ROLE,
        dataDirectory: DATA_DIR_NAME,
        initializedAt: new Date().toISOString(),
      };
      await writeAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      await unlink(progressPath).catch(() => undefined);
    }

    let stopped = false;
    const ownedChild = child;
    const stop = async () => {
      if (stopped) return;
      try {
        if (ownedChild) await stopProcess(ownedChild);
        child = undefined;
        if (lockHandle) {
          await lockHandle.close();
          lockHandle = undefined;
        }
        await unlink(lockPath);
        stopped = true;
      } catch (error) {
        throw safeError(error, 'Owned PostgreSQL failed to stop cleanly', secrets);
      }
    };

    return {
      adminUrl: connectionUrl(ADMIN_ROLE, adminPassword, port, APPLICATION_DATABASE),
      applicationUrl: connectionUrl(APPLICATION_ROLE, applicationPassword, port, APPLICATION_DATABASE),
      version,
      stop,
    };
  } catch (error) {
    await stopOwned(true).catch(() => undefined);
    throw safeError(error, 'Owned PostgreSQL failed to start. Data was preserved.', secrets);
  }
}
