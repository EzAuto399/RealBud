/**
 * Trusted operator command: read, create or update one company's RealBud service
 * entitlement in the ledger database the server uses. The operator route
 * `PUT /v1/operator/offices/entitlement` (operator-entitlement.ts) applies the
 * same rules through `entitlementFromFlags` and `entitlementView` below; this
 * command is the fallback when that route is not reachable.
 *
 *   cd managed-gateway
 *   node --experimental-strip-types entitlement-cli.ts get --company <companyId>
 *   node --experimental-strip-types entitlement-cli.ts set --company <companyId> --evidence <reference> \
 *     [--license <licenseId>] [--name <legal name>] [--address <address>] [--abn <11 digits>|none] \
 *     [--go-live <ISO date|epoch ms>] [--go-live-evidence <reference>] [--expires <ISO date|epoch ms>] [--active true|false]
 *
 * `set` on a new company needs every bracketed field except --abn and --active
 * (default true); on an existing one, each given field replaces the stored value.
 * The licence cannot change once set. The database must already exist (the
 * server creates it on first boot), so a wrong REALBUD_GATEWAY_DATA or working
 * directory fails instead of writing an entitlement the server never reads.
 *
 * An entitlement says whether the office's RealBud service may run. It holds no
 * AI rate, cap or invoice — those are Modelvia's — and nothing it prints is a
 * secret.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GatewayError, type ServiceEntitlement, type Tenant } from './contracts.ts';
import { LedgerDatabase } from './database.ts';
import { UsageLedger } from './ledger.ts';
import { ledgerPath, loadLocalEnv } from './local-env.ts';

const FLAGS: Record<string, string> = {
  '--company': 'company', '--evidence': 'evidence', '--license': 'license', '--name': 'name', '--address': 'address', '--abn': 'abn',
  '--go-live': 'goLive', '--go-live-evidence': 'goLiveEvidence', '--expires': 'expires', '--active': 'active',
};
const USAGE = 'Usage: entitlement-cli.ts get --company <id> | set --company <id> --evidence <reference> [--license <id>] [--name <text>] [--address <text>] [--abn <11 digits>|none] [--go-live <ISO|ms>] [--go-live-evidence <reference>] [--expires <ISO|ms>] [--active true|false]';

function fail(code: string): never { throw new GatewayError(code); }
function time(value: string): number {
  const parsed = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) fail('invalid_time');
  return parsed;
}
/** An entitlement as the command prints it; `now` decides `serviceAvailable`. */
export function entitlementView(tenant: Tenant, now: number) {
  return {
    companyId: tenant.companyId, licenseId: tenant.licenseId, active: tenant.active,
    serviceAvailable: tenant.active && tenant.serviceExpiresAt > now && now >= tenant.goLiveAt,
    goLiveAt: new Date(tenant.goLiveAt).toISOString(), serviceExpiresAt: new Date(tenant.serviceExpiresAt).toISOString(),
    customerName: tenant.customerName, customerAddress: tenant.customerAddress, ...(tenant.customerAbn ? { customerAbn: tenant.customerAbn } : {}),
    goLiveEvidence: tenant.goLiveEvidence,
  };
}

/** Flag values by field name (see `FLAGS`), as `set` reads them. */
export type EntitlementFlags = Partial<Record<'company' | 'license' | 'name' | 'address' | 'abn' | 'goLive' | 'goLiveEvidence' | 'expires' | 'active', string>>;

/** `set`'s rules: the entitlement to store for these flags over `current`. A new
 * company needs every field but the ABN and `active` (default true); on an
 * existing one each given field replaces the stored value. The ledger validates
 * the result (`putEntitlement`). */
export function entitlementFromFlags(flags: EntitlementFlags, current: Tenant | undefined): ServiceEntitlement {
  if (!current && !(flags.license && flags.name && flags.address && flags.goLive && flags.goLiveEvidence && flags.expires)) fail('entitlement_fields_required');
  if (flags.active !== undefined && flags.active !== 'true' && flags.active !== 'false') fail('invalid_service_state');
  const abn = flags.abn === undefined ? current?.customerAbn : flags.abn === 'none' ? undefined : flags.abn;
  return {
    companyId: flags.company!,
    licenseId: flags.license ?? current!.licenseId,
    active: flags.active === undefined ? (current?.active ?? true) : flags.active === 'true',
    serviceExpiresAt: flags.expires === undefined ? current!.serviceExpiresAt : time(flags.expires),
    customerName: flags.name ?? current!.customerName,
    customerAddress: flags.address ?? current!.customerAddress,
    ...(abn === undefined ? {} : { customerAbn: abn }),
    goLiveAt: flags.goLive === undefined ? current!.goLiveAt : time(flags.goLive),
    goLiveEvidence: flags.goLiveEvidence ?? current!.goLiveEvidence,
  };
}

/** Pure core, exported for tests. Returns the exit code; writes one JSON line. */
export function runEntitlementCli(argv: readonly string[], options: { env?: NodeJS.ProcessEnv; now?: () => number; out?: (line: string) => void; err?: (line: string) => void } = {}): number {
  const env = options.env ?? process.env, now = options.now ?? Date.now;
  const out = options.out ?? (line => process.stdout.write(`${line}\n`)), err = options.err ?? (line => process.stderr.write(`${line}\n`));
  const path = ledgerPath(env);
  let db: LedgerDatabase | undefined;
  try {
    const [command, ...rest] = argv;
    if (command !== 'get' && command !== 'set') fail('invalid_arguments');
    const flags: Record<string, string> = {};
    for (let i = 0; i < rest.length; i += 2) {
      const field = FLAGS[rest[i]!], value = rest[i + 1];
      if (!field || value === undefined || field in flags) fail('invalid_arguments');
      flags[field] = value!;
    }
    if (!flags.company) fail('invalid_arguments');
    if (!existsSync(path)) fail('ledger_database_missing');
    db = new LedgerDatabase(path);
    const ledger = new UsageLedger(db, now);
    const stored = db.get<{ body: string }>('SELECT body FROM tenants WHERE id=?', flags.company!);
    const current = stored ? JSON.parse(stored.body) as Tenant : undefined;
    if (command === 'get') {
      if (Object.keys(flags).length !== 1) fail('invalid_arguments');
      if (!current) fail('entitlement_not_found');
      out(JSON.stringify({ result: 'found', database: path, entitlement: entitlementView(current!, now()) }));
      return 0;
    }
    if (!flags.evidence) fail('invalid_arguments');
    const saved = ledger.putEntitlement(entitlementFromFlags(flags, current), flags.evidence!);
    out(JSON.stringify({ result: saved.created ? 'created' : 'updated', database: path, entitlement: entitlementView(saved.tenant, now()) }));
    return 0;
  } catch (error) {
    // A code only: never a stack, a value from the environment or the database body.
    err(JSON.stringify({ error: error instanceof GatewayError ? error.code : 'entitlement_failed', database: path }));
    if (error instanceof GatewayError && error.code === 'invalid_arguments') err(USAGE);
    return 1;
  } finally { db?.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadLocalEnv();
  process.exitCode = runEntitlementCli(process.argv.slice(2));
}
