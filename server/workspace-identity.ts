import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readPrivateJson, writePrivateJson } from './private-json.ts';

export interface WorkspaceIdentity {
  version: 1;
  id: string;
  /** Immutable legacy selection. Null preserves an existing solo profile. */
  workerMemberKey: string | null;
}
const validKey = (key: unknown): key is string => typeof key === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(key);

/** Called before work starts. Membership changes never alter this record. */
export async function loadWorkspaceIdentity(directory: string, override?: string): Promise<WorkspaceIdentity> {
  const path = join(directory, 'workspace.json');
  const saved = await readPrivateJson(path) as WorkspaceIdentity | undefined;
  if (saved !== undefined) {
    if (!saved || saved.version !== 1 || !/^[a-f0-9-]{36}$/.test(saved.id) ||
      !(saved.workerMemberKey === null || validKey(saved.workerMemberKey)) ||
      Object.keys(saved).sort().join(',') !== 'id,version,workerMemberKey') throw new Error('Workspace identity needs recovery.');
    if (override && saved.workerMemberKey !== override) throw new Error('Worker override does not match this private workspace.');
    return Object.freeze(saved);
  }
  const seat = await readPrivateJson(join(directory, 'seat.json')) as { version?: number; memberId?: unknown } | undefined;
  if (seat !== undefined && (!seat || seat.version !== 1 || !validKey(seat.memberId))) throw new Error('Saved member identity needs recovery.');
  if (override && !validKey(override)) throw new Error('Invalid private workspace override.');
  const identity: WorkspaceIdentity = { version: 1, id: randomUUID(), workerMemberKey: override || (seat?.memberId as string | undefined) || null };
  await writePrivateJson(path, identity);
  return Object.freeze(identity);
}
