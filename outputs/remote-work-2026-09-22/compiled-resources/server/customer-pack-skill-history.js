/** Pure, portable admission for immutable reviewed instruction history. */
import { createHash } from 'node:crypto';
export const SKILL_ARCHIVE_MAX_BYTES = 4_100_000;
export const SKILL_ARCHIVE_MAX_BATCHES = 10_000;
export const SKILL_HISTORY_PAGE_SIZE = 20;
export const PACK_JOURNAL_MAX_BYTES = 2_000_000;
export const SKILL_ARCHIVE_INTENT_ALLOWANCE = 16_384;
export const skillHistoryHash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const skillArchivePath = (packId, digest) => `customer-skill-history/${packId}/${digest}.json`;
export const isSkillArchivePath = (path) => /^customer-skill-history\/[a-z][a-z0-9-]{1,79}\/[a-f0-9]{64}\.json$/.test(path);
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v, keys) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const hex = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const id = (v) => typeof v === 'string' && /^[a-z][a-z0-9-]{1,79}$/.test(v);
const positive = (v) => Number.isSafeInteger(v) && Number(v) > 0;
function invalid() { throw Object.assign(new Error('Reviewed instruction history needs recovery. Existing instructions and history were preserved.'), { status: 409 }); }
export function skillArchiveHeadValid(v) {
    return object(v) && exact(v, ['digest', 'batches', 'revisions', 'throughRevision']) && hex(v.digest) && positive(v.batches) && v.batches <= SKILL_ARCHIVE_MAX_BATCHES && positive(v.revisions) && v.revisions >= v.batches && v.revisions <= v.batches * 98 && v.throughRevision === v.revisions;
}
function versionValid(v, canonical = true) {
    if (!object(v) || !positive(v.revision) || typeof v.content !== 'string' || createHash('sha256').update(v.content).digest('hex') !== v.digest || typeof v.createdAt !== 'string' || typeof v.reason !== 'string')
        return false;
    return !canonical || (exact(v, ['revision', 'digest', 'content', 'createdAt', 'reason']) && v.content.length <= 40_000 && Number.isFinite(Date.parse(v.createdAt)) && v.reason.length <= 500);
}
/** Legacy ordering and historical metadata remain readable for recovery. New
 * archives and mutations require an exact contiguous canonical sequence. */
export function validateSkillOverride(value, canonical = false) {
    if (!object(value) || !positive(value.activeRevision) || !Array.isArray(value.versions) || !value.versions.length || value.versions.length > 100 || value.versions.some(v => !versionValid(v, false)) || !value.versions.some(v => v.revision === value.activeRevision) || (value.archiveHead !== undefined && !skillArchiveHeadValid(value.archiveHead)))
        invalid();
    if (canonical || value.archiveHead) {
        if (Object.keys(value).some(k => !['activeRevision', 'versions', 'archiveHead'].includes(k)) || value.versions.some((v) => !versionValid(v)))
            invalid();
        const start = value.archiveHead?.throughRevision ?? 0;
        if (value.versions.some((v, i) => v.revision !== start + i + 1) || value.activeRevision !== start + value.versions.length)
            invalid();
    }
}
export function skillArchivePreviewDigest(entry, skillId, scope) {
    return skillHistoryHash({ packId: entry.pack.id, skillId, generation: entry.generation ?? 1, digest: entry.digest, scope, override: entry.overrides?.[skillId] ?? null });
}
export function skillHistoryArchive(entry, skillId, archivedAt, scope) {
    const override = entry.overrides?.[skillId];
    validateSkillOverride(override, true);
    const active = override.versions.at(-1);
    return { format: 'realbud-skill-history', version: 1, packId: entry.pack.id, skillId, previous: override.archiveHead ?? null, installedGeneration: entry.generation ?? 1, installedDigest: entry.digest, activeRevision: active.revision, activeDigest: active.digest, previewDigest: skillArchivePreviewDigest(entry, skillId, scope), scope, archivedAt, versions: override.versions.slice(0, -2) };
}
export function nextSkillArchiveHead(record, digest) {
    return { digest, batches: (record.previous?.batches ?? 0) + 1, revisions: (record.previous?.revisions ?? 0) + record.versions.length, throughRevision: record.versions.at(-1).revision };
}
export function validateSkillHistoryArchive(value, packId, skillId, digest) {
    if (!object(value) || !exact(value, ['format', 'version', 'packId', 'skillId', 'previous', 'installedGeneration', 'installedDigest', 'activeRevision', 'activeDigest', 'previewDigest', 'scope', 'archivedAt', 'versions']) || value.format !== 'realbud-skill-history' || value.version !== 1 || !id(packId) || value.packId !== packId || !id(skillId) || value.skillId !== skillId || !hex(digest) || skillHistoryHash(value) !== digest || Buffer.byteLength(JSON.stringify(value)) > SKILL_ARCHIVE_MAX_BYTES || !positive(value.installedGeneration) || !hex(value.installedDigest) || !positive(value.activeRevision) || !hex(value.activeDigest) || !hex(value.previewDigest) || !hex(value.scope) || typeof value.archivedAt !== 'string' || !Number.isFinite(Date.parse(value.archivedAt)) || (value.previous !== null && !skillArchiveHeadValid(value.previous)) || !Array.isArray(value.versions) || !value.versions.length || value.versions.length > 98 || value.versions.some(v => !versionValid(v)))
        invalid();
    const record = value;
    if ((record.previous?.batches ?? 0) >= SKILL_ARCHIVE_MAX_BATCHES || record.versions.some((v, i) => v.revision !== (record.previous?.throughRevision ?? 0) + i + 1) || record.versions.at(-1).revision !== record.activeRevision - 2)
        invalid();
    return record;
}
export function validateSkillRevertReceipt(value) {
    if (!object(value) || !exact(value, ['skillId', 'reviewDigest', 'selection', 'scope']) || !id(value.skillId) || !hex(value.reviewDigest) || !hex(value.scope) || !object(value.selection))
        invalid();
    const v = value.selection;
    if (!exact(v, ['installationRevision', 'head', 'sourceDigest', 'revision', 'digest']) || !positive(v.installationRevision) || !positive(v.revision) || !hex(v.digest) || !hex(v.sourceDigest) || (v.head !== null && !hex(v.head)))
        invalid();
}
function validateArchiveReceipt(intent) {
    if (!object(intent) || !exact(intent, ['skillId', 'previewDigest', 'fromGeneration', 'fromDigest', 'activeRevision', 'activeDigest', 'head', 'archivedAt', 'digest', 'scope']) || !id(intent.skillId) || !hex(intent.previewDigest) || !hex(intent.fromDigest) || !hex(intent.activeDigest) || !hex(intent.digest) || !hex(intent.scope) || !positive(intent.activeRevision) || !positive(intent.fromGeneration) || (intent.head !== null && !hex(intent.head)) || typeof intent.archivedAt !== 'string' || !Number.isFinite(Date.parse(intent.archivedAt)))
        invalid();
}
export function validateSkillArchiveJournal(entry) {
    for (const override of Object.values(entry.overrides ?? {}))
        validateSkillOverride(override);
    if (entry.lastSkillArchive)
        validateArchiveReceipt(entry.lastSkillArchive);
    const extras = entry;
    if (extras.lastSkillRevert)
        validateSkillRevertReceipt(extras.lastSkillRevert);
    if (extras.upgrade?.revertReceipt)
        validateSkillRevertReceipt(extras.upgrade.revertReceipt);
    const intent = entry.skillArchiveIntent;
    if (!intent)
        return;
    validateArchiveReceipt(intent);
    if (extras.upgrade)
        invalid();
    if (!object(intent) || !exact(intent, ['skillId', 'previewDigest', 'fromGeneration', 'fromDigest', 'activeRevision', 'activeDigest', 'head', 'archivedAt', 'digest', 'scope']) || !id(intent.skillId) || !hex(intent.previewDigest) || !hex(intent.fromDigest) || !hex(intent.activeDigest) || !hex(intent.digest) || !hex(intent.scope) || !positive(intent.activeRevision) || intent.fromGeneration !== (entry.generation ?? 1) || intent.fromDigest !== entry.digest || (intent.head !== null && !hex(intent.head)) || typeof intent.archivedAt !== 'string' || !Number.isFinite(Date.parse(intent.archivedAt)) || entry.transition || entry.archiveIntent)
        invalid();
    const override = entry.overrides?.[intent.skillId];
    validateSkillOverride(override, true);
    const record = skillHistoryArchive(entry, intent.skillId, intent.archivedAt, intent.scope);
    if (!record.versions.length || intent.activeRevision !== override.activeRevision || intent.activeDigest !== override.versions.at(-1).digest || intent.head !== (override.archiveHead?.digest ?? null) || record.previewDigest !== intent.previewDigest || skillHistoryHash(record) !== intent.digest)
        invalid();
    validateSkillHistoryArchive(record, entry.pack.id, intent.skillId, intent.digest);
}
/** Root v2 is a persistent downgrade gate. Only an exact compact pending intent
 * may borrow up to 16 KiB over a previously admissible <=2 MB journal. */
export function validateSkillJournalRoot(value) {
    if (!object(value) || !exact(value, ['version', 'installs']) || ![1, 2].includes(value.version) || !object(value.installs))
        invalid();
    let hasArchive = false, intents = 0;
    const inspect = (config) => { if (!config)
        return; for (const override of Object.values(config.overrides ?? {})) {
        validateSkillOverride(override);
        if (override.archiveHead)
            hasArchive = true;
    } };
    const stripped = structuredClone(value);
    for (const [packId, entry] of Object.entries(value.installs)) {
        if (!object(entry) || entry.pack?.id !== packId)
            invalid();
        validateSkillArchiveJournal(entry);
        inspect(entry);
        for (const snapshot of entry.history ?? [])
            inspect(snapshot);
        inspect(entry.transition?.target);
        inspect(entry.transition?.before);
        if (entry.skillArchiveIntent) {
            hasArchive = true;
            intents++;
            delete stripped.installs[packId].skillArchiveIntent;
        }
        if (entry.lastSkillArchive)
            hasArchive = true;
    }
    if (hasArchive && value.version !== 2)
        invalid();
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > PACK_JOURNAL_MAX_BYTES) {
        const base = Buffer.byteLength(JSON.stringify(stripped));
        if (!intents || base > PACK_JOURNAL_MAX_BYTES || bytes - base > SKILL_ARCHIVE_INTENT_ALLOWANCE || bytes > PACK_JOURNAL_MAX_BYTES + SKILL_ARCHIVE_INTENT_ALLOWANCE)
            invalid();
    }
}
