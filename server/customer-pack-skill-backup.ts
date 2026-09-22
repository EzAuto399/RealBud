/** Pure backup graph admission. Archive audit scope is provenance, never
 * destination execution authority. Live pack code must not import this module. */
import { validateCustomerPackHistoryArchive } from './customer-packs.ts';
import { packArchivePath, packChangeHash, type PackUpgradeState, type PackConfiguration } from './customer-pack-upgrades.ts';
import {
  isSkillArchivePath, skillArchivePath, validateSkillHistoryArchive, nextSkillArchiveHead,
  validateSkillOverride, validateSkillJournalRoot, SKILL_ARCHIVE_MAX_BATCHES,
  type SkillArchiveHead,
} from './customer-pack-skill-history.ts';

const invalid = (message = 'Reviewed instruction archive history needs recovery before backup.'): never => {
  throw Object.assign(new Error(message), { status: 400 });
};
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function validateCustomerSkillArchiveFile(path: string, value: unknown): void {
  if (!isSkillArchivePath(path) || !object(value) || typeof value.skillId !== 'string') return invalid();
  const [, packId, filename] = path.split('/');
  validateSkillHistoryArchive(value, packId, value.skillId, filename.slice(0, -5));
}
type Files = { get(path: string): unknown | undefined; paths(): Iterable<string> };
type Metadata = {
  packId: string; skillId: string; head: SkillArchiveHead; previous: SkillArchiveHead | null;
  installedGeneration: number; installedDigest: string; activeRevision: number; activeDigest: string;
  firstRevision: number; firstDigests: string[]; openCommitments: { revision: number; digest: string }[];
  complete: boolean;
};
/** Each immutable file is decoded/validated once. Each root still checks its own
 * claimed head counts, skill identity and configuration ordering. Cached values
 * contain only metadata; complete historical instruction text is not retained. */
export function validateCustomerSkillArchiveSet(journal: unknown, files: Files): void {
  const remaining = new Set<string>();
  for (const path of files.paths()) if (isSkillArchivePath(path)) {
    remaining.add(path);
    if (remaining.size > SKILL_ARCHIVE_MAX_BATCHES) return invalid('Instruction history exceeds the supported backup graph capacity.');
  }
  if (journal === undefined) {
    if (remaining.size) return invalid('Instruction archive history has no installation journal.');
    return;
  }
  validateSkillJournalRoot(journal);
  const root = journal as { version: number; installs: Record<string, PackUpgradeState> };
  const cache = new Map<string, Metadata>();
  let roots = 0;
  function configuration(config: PackConfiguration, generation: number) {
    for (const [skillId, override] of Object.entries(config.overrides ?? {})) {
      validateSkillOverride(override, !!override.archiveHead);
      if (!override.archiveHead) continue;
      if (root.version !== 2) return invalid('Archived instruction history requires the version 2 installation journal.');
      if (++roots > 100_000) return invalid('Instruction history exceeds the supported backup root capacity.');
      let head: SkillArchiveHead | null = override.archiveHead;
      const visiting = new Set<string>(), pending: Metadata[] = [];
      let newer: Metadata | undefined;
      let rootMetadata: Metadata | undefined;
      while (head) {
        const path = skillArchivePath(config.pack.id, head.digest);
        if (visiting.has(path)) return invalid('Instruction archive history contains a cycle.');
        visiting.add(path);
        let metadata = cache.get(path);
        if (!metadata) {
          if (!remaining.has(path)) return invalid('A referenced instruction archive is missing.');
          const archive = validateSkillHistoryArchive(files.get(path), config.pack.id, skillId, head.digest);
          metadata = { packId: archive.packId, skillId: archive.skillId, head: nextSkillArchiveHead(archive, head.digest),
            previous: archive.previous, installedGeneration: archive.installedGeneration, installedDigest: archive.installedDigest,
            activeRevision: archive.activeRevision, activeDigest: archive.activeDigest,
            firstRevision: archive.versions[0].revision, firstDigests: archive.versions.slice(0, 2).map(version => version.digest), openCommitments: [], complete: false };
          cache.set(path, metadata); remaining.delete(path);
        }
        rootMetadata ??= metadata;
        if (metadata.packId !== config.pack.id || metadata.skillId !== skillId || packChangeHash(metadata.head) !== packChangeHash(head)) return invalid('An instruction archive root has inconsistent counts or identity.');
        if (newer && (metadata.installedGeneration > newer.installedGeneration || metadata.installedGeneration === newer.installedGeneration && metadata.installedDigest !== newer.installedDigest || metadata.activeRevision > newer.activeRevision)) return invalid('Instruction archive audit ordering is inconsistent.');
        if (metadata.installedGeneration > generation || metadata.installedGeneration === generation && metadata.installedDigest !== config.digest || metadata.activeRevision > override.activeRevision) return invalid('An instruction archive does not belong to this saved configuration.');
        if (metadata.complete) break;
        pending.push(metadata); newer = metadata; head = metadata.previous;
      }
      for (const metadata of pending.reverse()) {
        const commitments = new Map<number, string>([[metadata.activeRevision, metadata.activeDigest]]);
        const previous = metadata.previous ? cache.get(skillArchivePath(metadata.packId, metadata.previous.digest)) : undefined;
        if (metadata.previous && !previous?.complete) return invalid();
        for (const commitment of previous?.openCommitments ?? []) {
          if (commitment.revision <= metadata.head.throughRevision) {
            if (metadata.firstDigests[commitment.revision - metadata.firstRevision] !== commitment.digest) return invalid('An archived instruction revision contradicts its earlier active digest.');
          } else {
            if (commitments.has(commitment.revision) && commitments.get(commitment.revision) !== commitment.digest) return invalid();
            commitments.set(commitment.revision, commitment.digest);
          }
        }
        // Each archive retains its two newest versions inline, so at most the
        // next two revisions can carry commitments into a later batch/root.
        metadata.openCommitments = [...commitments].map(([revision, digest]) => ({ revision, digest }));
        if (metadata.openCommitments.length > 2 || metadata.openCommitments.some(commitment => commitment.revision <= metadata.head.throughRevision || commitment.revision > metadata.head.throughRevision + 2)) return invalid();
        metadata.complete = true;
      }
      for (const commitment of rootMetadata?.openCommitments ?? []) {
        if (override.versions.find(version => version.revision === commitment.revision)?.digest !== commitment.digest) return invalid('A reviewed instruction revision contradicts its archived active digest.');
      }
    }
  }
  for (const [packId, entry] of Object.entries(root.installs)) {
    const state = entry as unknown as Record<string, unknown>;
    if (entry.pack.id !== packId || state.skillArchiveIntent || state.upgrade || state.initialApprovalReset || entry.archiveIntent || entry.transition) return invalid('Finish or recover the saved instruction pack change before creating a backup.');
    configuration(entry, entry.generation ?? 1);
    for (const snapshot of entry.history ?? []) configuration(snapshot, snapshot.generation);
    let head = entry.archiveHead;
    const seen = new Set<string>();
    while (head) {
      const path = packArchivePath(packId, head.digest);
      if (seen.has(path)) return invalid('Pack archive history contains a cycle.');
      seen.add(path);
      const archive = validateCustomerPackHistoryArchive(files.get(path), packId, head.digest);
      for (const snapshot of archive.snapshots) configuration(snapshot, snapshot.generation);
      head = archive.previous ?? undefined;
    }
  }
  if (remaining.size) return invalid('Unreferenced instruction archive history needs recovery before backup.');
}
