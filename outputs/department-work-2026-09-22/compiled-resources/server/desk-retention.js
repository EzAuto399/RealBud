import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
const DAY_MS = 24 * 60 * 60 * 1000;
/** Evidence referenced by any Case is audit material, including Cases with a
 * Decision or Handoff. Current projections also retain their exact source.
 * Only unreferenced history older than policy is eligible for deletion. */
export function applyRetentionPolicy(book, now) {
    if (book.retentionDays === null)
        return { book, evidencePurged: 0, positionsPurged: 0 };
    if (!Number.isInteger(book.retentionDays) || book.retentionDays < 1 || book.retentionDays > 3_650) {
        throw new Error("retentionDays must be an integer from 1 to 3650 or null");
    }
    const cutoff = now - book.retentionDays * DAY_MS;
    const protectedIds = new Set();
    for (const item of book.cases)
        for (const id of item.evidenceIds ?? [])
            protectedIds.add(id);
    for (const position of book.moneyPositions) {
        if (position.status === "current")
            protectedIds.add(position.evidenceId);
    }
    const retainedEvidence = book.evidence.filter((item) => item.ingestedAt >= cutoff || item.observedAt === null || protectedIds.has(item.id));
    const retainedIds = new Set(retainedEvidence.map((item) => item.id));
    const retainedPositions = book.moneyPositions.filter((position) => retainedIds.has(position.evidenceId));
    const evidencePurged = book.evidence.length - retainedEvidence.length;
    const positionsPurged = book.moneyPositions.length - retainedPositions.length;
    if (!evidencePurged && !positionsPurged)
        return { book, evidencePurged: 0, positionsPurged: 0 };
    return {
        book: { ...book, evidence: retainedEvidence, moneyPositions: retainedPositions },
        evidencePurged,
        positionsPurged,
    };
}
export function pruneDeskBackups(backupDir, retentionDays, now, maxBackups = 5) {
    if (!existsSync(backupDir))
        return { removed: [] };
    const files = readdirSync(backupDir)
        .filter((name) => /^(?:desk-|pre-v3-|purged-desk-).+\.json$/.test(name))
        .map((name) => ({ name, path: join(backupDir, name), mtimeMs: statSync(join(backupDir, name)).mtimeMs }))
        .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
    const ordinary = files.filter((item) => item.name.startsWith("desk-"));
    const overLimit = new Set(ordinary.slice(Math.max(0, maxBackups)).map((item) => item.path));
    const cutoff = retentionDays === null ? Number.NEGATIVE_INFINITY : now - retentionDays * DAY_MS;
    const removed = [];
    for (const item of files) {
        if (!overLimit.has(item.path) && item.mtimeMs >= cutoff && !item.name.startsWith("purged-desk-"))
            continue;
        unlinkSync(item.path);
        removed.push(item.path);
    }
    return { removed };
}
