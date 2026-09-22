/** Keep the original JSON API usable after the durable journal is installed.
 * It enters the same authenticated, bound v2 restore path as streamed uploads. */
import { createHash, randomUUID } from 'node:crypto';
import type { createPrivateWorkspaceBackup } from './private-workspace-backup.ts';
import type { createPrivateBackupCoordinator } from './private-backup-coordinator.ts';
import { PRIVATE_BACKUP_TRANSFER_CHUNK_BYTES as CHUNK } from '../shared/private-backup-transfers.ts';

export function withDurablePrivateBackupRestore(legacy: ReturnType<typeof createPrivateWorkspaceBackup>, coordinator: Awaited<ReturnType<typeof createPrivateBackupCoordinator>>) {
  return {
    ...legacy,
    async status() {
      const current = await legacy.status(), held = coordinator.heldOperation();
      if (!held) return current;
      return { ...current, state: held.phase === 'applying' ? 'applying' as const : 'staged' as const, receipt: held.preview ?? null,
        ...(held.phase === 'staged' || held.phase === 'applying' ? {} : { completionWarning: 'Restore preparation needs recovery. Its files are retained; check the saved operation before restarting.' }) };
    },
    async stageRestore(input: { backup: unknown; passphrase: unknown; expectedDigest: unknown }) {
      const receipt = await legacy.previewBackup(input.backup, input.passphrase);
      if (receipt.digest !== input.expectedDigest) throw Object.assign(new Error('The reviewed backup changed. Preview it again.'), { status: 409 });
      const bytes = Buffer.from(JSON.stringify(input.backup)), id = randomUUID(), tuples: [number, number, string][] = [];
      try {
        await coordinator.startUpload(id, bytes.length);
        for (let offset = 0; offset < bytes.length; offset += CHUNK) { const chunk = bytes.subarray(offset, offset + CHUNK), digest = createHash('sha256').update(chunk).digest('hex'); tuples.push([offset, chunk.length, digest]); await coordinator.appendUpload(id, offset, chunk, digest); }
        await coordinator.sealUpload(id, bytes.length, createHash('sha256').update(JSON.stringify(tuples)).digest('hex'));
        await coordinator.preview(id, input.passphrase as string, receipt.digest); const reviewed = await coordinator.settled(id);
        if (reviewed.phase !== 'reviewed') throw Object.assign(new Error('The private backup could not be prepared. Check its saved status.'), { status: 409 });
        const staged = await coordinator.stage(id, receipt.digest);
        if (staged.phase !== 'staged') throw Object.assign(new Error('Restore preparation needs recovery.'), { status: 503 });
        return { needsRestart: true as const, receipt: staged.preview! };
      } finally { bytes.fill(0); }
    },
  };
}
