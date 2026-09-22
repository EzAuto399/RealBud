#!/usr/bin/env node
// Thin CLI over provisioning.ts. Run only on the trusted service/operator
// machine. Creates no provider calls. The logic lives in provisioning.ts so the
// vendor-side HTTP provisioning route and this CLI admit devices the same way.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { provisionConnector } from './provisioning.ts';

export { provisionConnector };

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    if(process.argv.slice(2).join(' ')==='--help') {
      console.log('node provision-connector.mjs --registry /private/devices.json --device-file /private/new-device.json --client-output /private/new-client-access.json --endpoint https://service.example.com\nDevice descriptor: id, companyId, licenseId, memberId, installationId, profile, active, expiresAt, projectKeyEnv, authConfigId, userId; optional accountId and apps (default ["gmail"]). No secret values or tokenHash. Register the company subscription separately. Output contains one scoped credential, not a provider key; transfer it privately.');
    } else {
      const flags={'--registry':'registry','--device-file':'deviceFile','--client-output':'clientOutput','--endpoint':'endpoint'},options={};
      const args=process.argv.slice(2);for(let i=0;i<args.length;i+=2){const field=flags[args[i]];if(!field||!args[i+1]||options[field])throw new Error('Invalid arguments; use --help.');options[field]=args[i+1];}
      console.log(JSON.stringify(provisionConnector(options)));
    }
  } catch { console.error('Connector provisioning could not finish. Check paths, descriptor, existing device IDs and the private client output. No credential is printed.');process.exitCode=1; }
}
