import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
/** Independent published bytes; never derive a new agency pack at runtime from
 * an edited customer installation or inject local accounts, mappings or paths. */
export function officeCoreCustomerPack() {
    return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'pack', 'workflows', 'office-core', 'realbud-office-core-v1.json'), 'utf8'));
}
