// Regenerates the Auston pack JSON in pack/workflows/austin-office/ from
// server/customer-pack-definition.ts with the same validation and bytes as the
// /api/customer-packs/<id>/export route. Never hand-edit the JSON.
//   node --experimental-strip-types scripts/export-austin-office-pack.ts          write
//   node --experimental-strip-types scripts/export-austin-office-pack.ts --check  fail on drift
// The role packs (austin-accounts, austin-property) are what the owner signs
// with scripts/sign-pack.mjs and uploads to the office on realbud.app.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { austinAccountsCustomerPack, austinCustomerPack, austinPropertyCustomerPack } from '../server/customer-pack-definition.ts';
import { validateCustomerPack } from '../server/customer-packs.ts';

const folder = join(dirname(fileURLToPath(import.meta.url)), '..', 'pack', 'workflows', 'austin-office');
const packs = { 'realbud-austin-office-v1.json': austinCustomerPack, 'realbud-austin-accounts-v1.json': austinAccountsCustomerPack, 'realbud-austin-property-v1.json': austinPropertyCustomerPack };
let drift = false;
for (const [name, build] of Object.entries(packs)) {
  const target = join(folder, name), bytes = `${JSON.stringify(validateCustomerPack(build()), null, 2)}\n`;
  if (!process.argv.includes('--check')) { writeFileSync(target, bytes); console.log(`Wrote pack/workflows/austin-office/${name} (${Buffer.byteLength(bytes)} bytes).`); continue; }
  let current = ''; try { current = readFileSync(target, 'utf8'); } catch { /* missing counts as drift */ }
  if (current !== bytes) { console.error(`${name} differs from server/customer-pack-definition.ts. Regenerate it.`); drift = true; }
  else console.log(`${name} matches the definition.`);
}
if (drift) process.exit(1);
