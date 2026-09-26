/** One local service handoff at a time, including across administrator CLI
 * processes. A crash leaves the lock for deliberate operator recovery rather
 * than guessing that an old PID is safe to take over. */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { privateDirectory, readPrivateJson, removePrivateJson } from './private-json.ts';
import { writeNewPrivateFile } from './private-file.ts';

export const serviceEntitlementInstallLockPath = (dataDirectory: string): string =>
  join(dataDirectory, '.service-entitlement-install.lock');

export async function withServiceEntitlementInstallLock<T>(dataDirectory: string, work: () => Promise<T>): Promise<T> {
  await privateDirectory(dataDirectory);
  const path = serviceEntitlementInstallLockPath(dataDirectory);
  const nonce = randomUUID();
  try {
    await writeNewPrivateFile(path, JSON.stringify({ schema: 1, pid: process.pid, startedAt: Date.now(), nonce }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('A service entitlement install is already in progress. Inspect the lock before recovery.');
    }
    throw error;
  }
  try { return await work(); }
  finally {
    const current = await readPrivateJson(path, 2048);
    if (!current || typeof current !== 'object' || Array.isArray(current) ||
      (current as Record<string, unknown>).nonce !== nonce) {
      throw new Error('Service entitlement install lock changed. Inspect the lock before recovery.');
    }
    await removePrivateJson(path);
  }
}
