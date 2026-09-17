// Test infrastructure only. Never imported by the product server or installer.
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { migrateCompanySchema } from './schema.ts';

const execute = promisify(execFile);

/** Uses existing PostgreSQL executables only. Unix socket, private dirs, no TCP. */
export async function startCompanyPostgresFixture(options: { outputDirectory: string; postgresBinDirectory?: string }) {
  if (process.platform === 'win32') throw new Error('Unix-socket test fixture: Windows native setup needs its separate delivery test');
  const binaries = options.postgresBinDirectory ?? '/opt/homebrew/bin';
  const binary = (name: string) => join(binaries, name);
  const version = (await execute(binary('postgres'), ['--version'])).stdout.trim();
  if (!/PostgreSQL\) 16\./.test(version)) throw new Error('This fixture is admitted for installed PostgreSQL 16 only');
  const output = resolve(options.outputDirectory);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(output, 'postgres-fixture-'));
  const socket = await mkdtemp(join(tmpdir(), 'rb-company-pg-'));
  const data = join(directory, 'data');
  const port = '55447'; // Unique private socket directory means no global port binding.
  const database = 'realbud_company_test_fixture';
  const administrator = 'realbud_test_admin';
  const applicationRole = 'rb_company_test_app';
  let started = false;
  let stopped = false;
  let adminPool: Pool | undefined;
  let pool: Pool | undefined;
  const connection = (user: string) => {
    const url = new URL(`postgresql://${user}@localhost/${database}`);
    url.searchParams.set('host', socket);
    url.searchParams.set('port', port);
    return url.toString();
  };
  async function stop() {
    if (stopped) return;
    await Promise.all([pool?.end(), adminPool?.end()]);
    if (started) await execute(binary('pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop']);
    // Remove the owned disposable database/socket, preserve logs and receipt.
    await rm(data, { recursive: true, force: true });
    await rm(socket, { recursive: true, force: true });
    await writeFile(join(directory, 'fixture.json'), JSON.stringify({ version, database, transport: 'private Unix socket; TCP disabled', stopped: true }, null, 2));
    stopped = true;
  }
  try {
    const initialized = await execute(binary('initdb'), ['-D', data, '-A', 'trust', '-U', administrator, '--no-locale']);
    await writeFile(join(directory, 'initdb.log'), initialized.stdout + initialized.stderr);
    await execute(binary('pg_ctl'), ['-D', data, '-l', join(directory, 'postgres.log'), '-o', `-h '' -k ${socket} -p ${port}`, '-w', 'start']);
    started = true;
    await execute(binary('createdb'), ['-h', socket, '-p', port, '-U', administrator, database]);
    adminPool = new Pool({ connectionString: connection(administrator) });
    await adminPool.query(`CREATE ROLE ${applicationRole} LOGIN NOSUPERUSER NOBYPASSRLS`);
    await migrateCompanySchema(adminPool, { applicationRole });
    pool = new Pool({ connectionString: connection(applicationRole), max: 4 });
    await writeFile(join(directory, 'fixture.json'), JSON.stringify({ version, database, transport: 'private Unix socket; TCP disabled', stopped: false }, null, 2));
    return { adminPool, pool, applicationUrl: connection(applicationRole), adminUrl: connection(administrator), directory, version, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
