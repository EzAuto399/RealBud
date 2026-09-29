/** Run on the linked Mac, with a bundle transferred through an owner-controlled
 * channel and the public-key digest checked against the gateway issuer receipt.
 * node --experimental-strip-types server/service-entitlement-install-cli.ts
 *   --data "$HOME/.realbud" --bundle /private/path/bundle.json
 *   --public-key-sha256 <digest-from-operator> [--retire-previous-keys]
 */
import { fileURLToPath } from 'node:url';
import { installDesktopServiceEntitlement } from './service-entitlement-install.ts';

function parse(args: string[]): Record<string, string> {
  const allowed = new Set(['--data', '--bundle', '--public-key-sha256']);
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length;) {
    const key = args[i], value = args[i + 1];
    if (key === '--retire-previous-keys' && !flags[key]) { flags[key] = 'true'; i++; continue; }
    if (!key || !allowed.has(key) || !value || flags[key]) throw new Error('usage');
    flags[key] = value;
    i += 2;
  }
  if (![...allowed].every(key => flags[key])) throw new Error('usage');
  return flags;
}

export async function runServiceEntitlementInstallCli(args: string[],
  out: (line: string) => void = console.log, err: (line: string) => void = console.error): Promise<number> {
  try {
    const flags = parse(args);
    const result = await installDesktopServiceEntitlement({ dataDirectory: flags['--data']!,
      bundlePath: flags['--bundle']!, expectedPublicKeySha256: flags['--public-key-sha256']!,
      retirePreviousKeys: flags['--retire-previous-keys'] === 'true' });
    out(JSON.stringify({ result: 'installed', ...result, previousKeysRetired: flags['--retire-previous-keys'] === 'true' }));
    return 0;
  } catch {
    err(JSON.stringify({ error: 'service_entitlement_install_failed' }));
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await runServiceEntitlementInstallCli(process.argv.slice(2));
}
