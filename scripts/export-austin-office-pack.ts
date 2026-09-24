// Regenerates pack/workflows/austin-office/realbud-austin-office-v1.json from
// server/customer-pack-definition.ts with the same validation and bytes as the
// /api/customer-packs/austin-office/export route. Never hand-edit the JSON.
//   node --experimental-strip-types scripts/export-austin-office-pack.ts          write
//   node --experimental-strip-types scripts/export-austin-office-pack.ts --check  fail on drift
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { austinCustomerPack } from '../server/customer-pack-definition.ts';
import { validateCustomerPack } from '../server/customer-packs.ts';

const target = join(dirname(fileURLToPath(import.meta.url)), '..', 'pack', 'workflows', 'austin-office', 'realbud-austin-office-v1.json');
const bytes = `${JSON.stringify(validateCustomerPack(austinCustomerPack()), null, 2)}\n`;
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== bytes) { console.error('realbud-austin-office-v1.json differs from server/customer-pack-definition.ts. Regenerate it.'); process.exit(1); }
  console.log('realbud-austin-office-v1.json matches the definition.');
} else {
  writeFileSync(target, bytes);
  console.log(`Wrote ${target.slice(target.indexOf('pack/'))} (${Buffer.byteLength(bytes)} bytes).`);
}
