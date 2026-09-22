import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readPrivateJson, writePrivateJson } from "./private-json.js";
const validKey = (key) => typeof key === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(key);
/** Called before work starts. Membership changes never alter this record. */
export async function loadWorkspaceIdentity(directory, override) {
    const path = join(directory, 'workspace.json');
    const saved = await readPrivateJson(path);
    if (saved !== undefined) {
        if (!saved || saved.version !== 1 || !/^[a-f0-9-]{36}$/.test(saved.id) ||
            !(saved.workerMemberKey === null || validKey(saved.workerMemberKey)) ||
            Object.keys(saved).sort().join(',') !== 'id,version,workerMemberKey')
            throw new Error('Workspace identity needs recovery.');
        if (override && saved.workerMemberKey !== override)
            throw new Error('Worker override does not match this private workspace.');
        return Object.freeze(saved);
    }
    const seat = await readPrivateJson(join(directory, 'seat.json'));
    if (seat !== undefined && (!seat || seat.version !== 1 || !validKey(seat.memberId)))
        throw new Error('Saved member identity needs recovery.');
    if (override && !validKey(override))
        throw new Error('Invalid private workspace override.');
    const identity = { version: 1, id: randomUUID(), workerMemberKey: override || seat?.memberId || null };
    await writePrivateJson(path, identity);
    return Object.freeze(identity);
}
