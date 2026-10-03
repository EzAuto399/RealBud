import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CustomerPack } from '../shared/customer-packs.ts';

/** Fixed, agency-neutral plan text. Importing it transfers no case data or authority. */
export function departmentStarterCustomerPack(): CustomerPack {
  return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'pack', 'workflows', 'department-starters', 'realbud-department-starters-v1.json'), 'utf8')) as CustomerPack;
}
