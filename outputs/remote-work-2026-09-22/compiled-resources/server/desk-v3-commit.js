// Atomic encrypted V2→V3 cutover. On any failure, desk.json stays byte-identical.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fsyncDir, writeFileAtomic, writeFileFsynced } from "./atomic.js";
// local copy: importing from desk-store would be a circular import
const hostTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "Australia/Sydney";
import { failClosedRecovery, idleRecovery, locksForRecovery } from "./desk-v3-recovery.js";
import { decryptJson, encryptJson, isEncryptedEnvelope } from "./desk-crypto.js";
import { decodeDeskPlain, decodeDeskV3, validateDeskV3 } from "./desk-v3-decode.js";
import { migrateV2ToV3 } from "./desk-v3-migrate.js";
export const COMMIT_PHASES = [
    "retain-bytes",
    "hash-original",
    "decode",
    "backup-write",
    "backup-fsync",
    "backup-readback",
    "migrate",
    "validate",
    "encrypt-candidate",
    "candidate-write",
    "candidate-fsync",
    "candidate-readback",
    "candidate-decrypt",
    "candidate-validate",
    "rename",
    "dir-fsync",
];
export class CommitFailed extends Error {
    phase;
    constructor(phase, cause) {
        super(cause instanceof Error ? cause.message : `commit failed at ${phase}`);
        this.name = "CommitFailed";
        this.phase = phase;
    }
}
export function ciphertextHash(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}
export function preV3BackupPath(file, hash) {
    return join(dirname(file), "desk-backups", `pre-v3-${hash.slice(0, 16)}.json`);
}
export function candidatePath(file) {
    return `${file}.v3-candidate`;
}
export function commitV2ToV3(opts) {
    const fail = (phase) => {
        if (opts.failAt === phase)
            throw new CommitFailed(phase);
    };
    fail("retain-bytes");
    if (!existsSync(opts.file))
        throw new CommitFailed("retain-bytes", new Error("desk.json is missing"));
    const original = readFileSync(opts.file);
    fail("hash-original");
    const originalHash = ciphertextHash(original);
    fail("decode");
    let parsed;
    try {
        parsed = JSON.parse(original.toString("utf8"));
        if (isEncryptedEnvelope(parsed))
            parsed = decryptJson(opts.key, parsed);
    }
    catch (error) {
        throw new CommitFailed("decode", error);
    }
    const decoded = decodeDeskPlain(parsed, opts.book ?? { properties: [], ledger: [] }, opts.timezone ?? hostTimezone());
    if (decoded.version === 3) {
        return { v3: decoded.data, originalHash, backupPath: null, rewritten: false };
    }
    fail("backup-write");
    const backup = preV3BackupPath(opts.file, originalHash);
    mkdirSync(dirname(backup), { recursive: true });
    writeFileFsynced(backup, original);
    fail("backup-fsync");
    fsyncDir(dirname(backup));
    fail("backup-readback");
    const backupBytes = readFileSync(backup);
    if (ciphertextHash(backupBytes) !== originalHash)
        throw new CommitFailed("backup-readback", new Error("pre-migration backup hash mismatch"));
    fail("migrate");
    const migrated = migrateV2ToV3(decoded.data, opts.migratedAt);
    fail("validate");
    validateDeskV3(migrated);
    fail("encrypt-candidate");
    const envelope = encryptJson(opts.key, migrated);
    const candidate = candidatePath(opts.file);
    fail("candidate-write");
    writeFileAtomic(candidate, JSON.stringify(envelope));
    fail("candidate-fsync");
    fsyncDir(dirname(candidate));
    fail("candidate-readback");
    const readBack = JSON.parse(readFileSync(candidate, "utf8"));
    fail("candidate-decrypt");
    if (!isEncryptedEnvelope(readBack))
        throw new CommitFailed("candidate-decrypt", new Error("candidate is not an envelope"));
    const inner = decryptJson(opts.key, readBack);
    fail("candidate-validate");
    const checked = decodeDeskV3(inner);
    fail("rename");
    renameSync(candidate, opts.file);
    fail("dir-fsync");
    fsyncDir(dirname(opts.file));
    try {
        unlinkSync(candidate);
    }
    catch {
        /* renamed away */
    }
    return { v3: checked, originalHash, backupPath: backup, rewritten: true };
}
export function commitOrRecover(opts) {
    try {
        const result = commitV2ToV3(opts);
        const recovery = idleRecovery();
        return { ok: true, ...result, recovery, locks: locksForRecovery(recovery) };
    }
    catch (error) {
        const recovery = failClosedRecovery(error instanceof Error ? error.message : "commit failed");
        return {
            ok: false,
            recovery,
            locks: locksForRecovery(recovery),
            fileUnchanged: true,
            phase: error instanceof CommitFailed ? error.phase : undefined,
        };
    }
}
