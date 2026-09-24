/**
 * What `server.ts` and the operator commands share about where they run: the
 * optional `.env.local` beside this file, and the one ledger database path.
 * An operator command must open exactly the database the server opens, or an
 * entitlement it writes is one the server never reads.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Fill unset variables from `managed-gateway/.env.local`. Values are never printed. */
export function loadLocalEnv(env: NodeJS.ProcessEnv = process.env, file = resolve(dirname(fileURLToPath(import.meta.url)), '.env.local')): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const cut = trimmed.indexOf('=');
    const key = trimmed.slice(0, cut).trim();
    if (key && env[key] === undefined) env[key] = trimmed.slice(cut + 1);
  }
}

/** `$REALBUD_GATEWAY_DATA/ledger.sqlite`, default `./data`, resolved against the working directory. */
export function ledgerPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.REALBUD_GATEWAY_DATA || './data', 'ledger.sqlite');
}
