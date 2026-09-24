/**
 * Trusted operator command: re-apply one company's Modelvia caps to every ready
 * installation project, after the office's Modelvia customer changed its monthly
 * cap or concurrency. Provisioning copies caps once; this is the only refresh.
 * Never an HTTP route.
 *
 *   cd managed-gateway
 *   node --experimental-strip-types caps-cli.ts apply --company <companyId>
 *
 * Needs the Modelvia operator variables (`REALBUD_MODELVIA_BASE_URL`,
 * `REALBUD_MODELVIA_OPERATOR_SECRET`, `REALBUD_MODELVIA_OPERATOR_SUBJECT`,
 * `REALBUD_MODELVIA_CLIENT_ID`) and the ledger database the server uses. It
 * prints installation ids and states only: never a secret, a Modelvia customer
 * id or an upstream body. Exit 0 only when every installation was applied.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GatewayError } from './contracts.ts';
import { LedgerDatabase } from './database.ts';
import { UsageLedger } from './ledger.ts';
import { ledgerPath, loadLocalEnv } from './local-env.ts';
import type { HttpTransport } from './composio-org.ts';
import type { ModelviaClient } from './modelvia-keys.ts';
import { applyCustomerCaps, composeModelvia, MODELVIA_OPERATOR_ENV } from './provisioning.ts';

const USAGE = 'Usage: caps-cli.ts apply --company <companyId>';
function fail(code: string): never { throw new GatewayError(code); }

/** Pure core, exported for tests. Returns the exit code; writes one JSON line.
 * `modelvia` replaces the composed client in tests; the environment is still
 * required and validated. */
export async function runCapsCli(argv: readonly string[], options: { env?: NodeJS.ProcessEnv; now?: () => number; fetch?: HttpTransport; modelvia?: ModelviaClient; out?: (line: string) => void; err?: (line: string) => void } = {}): Promise<number> {
  const env = options.env ?? process.env, now = options.now ?? Date.now;
  const out = options.out ?? (line => process.stdout.write(`${line}\n`)), err = options.err ?? (line => process.stderr.write(`${line}\n`));
  const path = ledgerPath(env);
  let db: LedgerDatabase | undefined;
  try {
    if (argv.length !== 3 || argv[0] !== 'apply' || argv[1] !== '--company') fail('invalid_arguments');
    const companyId = argv[2]!;
    for (const name of MODELVIA_OPERATOR_ENV) if (!(env[name] ?? '').trim()) fail(`modelvia_unconfigured:${name}`);
    const composed = composeModelvia({ env, fetch: options.fetch ?? fetch });
    if ('unavailable' in composed) fail(composed.unavailable);
    if (!existsSync(path)) fail('ledger_database_missing');
    db = new LedgerDatabase(path);
    const ledger = new UsageLedger(db, now);
    // A company with no entitlement is a typo or the wrong database, not "nothing to do".
    ledger.tenant(companyId);
    const installations = await applyCustomerCaps({ ledger, modelvia: options.modelvia ?? composed.modelvia, requestCapNanoAud: composed.requestCapNanoAud }, companyId);
    const failed = installations.filter(entry => entry.state === 'failed').length;
    const result = installations.length === 0 ? 'none' : failed === 0 ? 'applied' : failed === installations.length ? 'failed' : 'partial';
    out(JSON.stringify({ result, database: path, installations }));
    return failed ? 1 : 0;
  } catch (error) {
    // A code only: never a stack, a value from the environment or the database body.
    err(JSON.stringify({ error: error instanceof GatewayError ? error.code : 'caps_apply_failed', database: path }));
    if (error instanceof GatewayError && error.code === 'invalid_arguments') err(USAGE);
    return 1;
  } finally { db?.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadLocalEnv();
  process.exitCode = await runCapsCli(process.argv.slice(2));
}
