import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CustomerPack } from '../shared/customer-packs.ts';

const workflows = join(dirname(fileURLToPath(import.meta.url)), '..', 'pack', 'workflows');
/** Shipped text read with LF line endings, so a CRLF checkout or editor save
 * yields the same bytes on Windows as on macOS. */
const readText = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

/** The REI recipes and site map shipped with the app, read at call time so
 * reviewed changes to them need no hash pin here. */
export function austinReiFiles(): { 'rei/recipes.json': string; 'rei/site-map.json': string } {
  const rei = join(workflows, 'austin-accounts', 'support/rei-cloud-navigation');
  return { 'rei/recipes.json': readText(join(rei, 'recipes.json')), 'rei/site-map.json': readText(join(rei, 'site-map.json')) };
}

/** Published bytes, read fresh on every call like office-core; never rebuilt
 * in code. Changing one means a new reviewed revision of that JSON file. */
const published = (file: string) => (): CustomerPack => JSON.parse(readFileSync(join(workflows, 'austin-office', file), 'utf8')) as CustomerPack;
export const austinCustomerPack = published('realbud-austin-office-v1.json');
export const austinAccountsCustomerPack = published('realbud-austin-accounts-v1.json');
export const austinPropertyCustomerPack = published('realbud-austin-property-v1.json');
