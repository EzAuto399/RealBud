#!/usr/bin/env node
/** Service-machine-only offline maintenance; no env key, provider or upload. */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGatewayRecoveryKey, exportGatewayBackup, restoreGatewayBackup, verifyGatewayBackup } from './gateway-backup.ts';
import { ledgerPath, loadLocalEnv } from './local-env.ts';

export async function runGatewayBackupCli(args: string[], env: NodeJS.ProcessEnv = process.env, out: (line: string) => void = console.log, err: (line: string) => void = console.error): Promise<number> {
  try {
    const [command, ...rest] = args, flags: Record<string, string> = {};
    for (let i = 0; i < rest.length; i += 2) {
      if (!/^--(key-file|output|archive|target|scratch|revision)$/.test(rest[i] ?? '') || !rest[i + 1] || flags[rest[i]!]) throw Error('gateway_backup_arguments');
      flags[rest[i]!] = rest[i + 1]!;
    }
    const fields = (...keys: string[]) => { if (Object.keys(flags).some(key => !keys.includes(key)) || keys.filter(key => key !== '--revision').some(key => !flags[key])) throw Error('gateway_backup_arguments'); };
    let receipt;
    if (command === 'key-create') { fields('--key-file'); receipt = createGatewayRecoveryKey(flags['--key-file']!); }
    else if (command === 'export') {
      fields('--key-file', '--output', '--revision'); loadLocalEnv(env);
      receipt = await exportGatewayBackup({ directory: dirname(ledgerPath(env)), keyFile: flags['--key-file']!, output: flags['--output']!, ...(flags['--revision'] ? { sourceRevision: flags['--revision'] } : {}),
        ...(env.REALBUD_GATEWAY_CONNECTOR_REGISTRY?.trim() ? { registry: env.REALBUD_GATEWAY_CONNECTOR_REGISTRY.trim() } : {}), ...(env.REALBUD_GATEWAY_SECRETS_DIR?.trim() ? { secrets: env.REALBUD_GATEWAY_SECRETS_DIR.trim() } : {}) });
    } else if (command === 'verify') { fields('--key-file', '--archive', '--scratch'); receipt = verifyGatewayBackup({ keyFile: flags['--key-file']!, archive: flags['--archive']!, scratchDirectory: flags['--scratch']! }); }
    else if (command === 'restore') { fields('--key-file', '--archive', '--target'); receipt = restoreGatewayBackup({ keyFile: flags['--key-file']!, archive: flags['--archive']!, directory: flags['--target']! }); }
    else throw Error('gateway_backup_arguments');
    out(JSON.stringify(receipt)); return 0;
  } catch (error) {
    // Fixed bounded codes only; paths, secret references, SQLite rows and
    // provider/customer content never ride an exception into the console.
    const code = error instanceof Error && /^gateway_[a-z_]{1,100}$/.test(error.message) ? error.message : 'gateway_backup_failed';
    err(JSON.stringify({ status: 'refused', error: code })); return 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await runGatewayBackupCli(process.argv.slice(2));
