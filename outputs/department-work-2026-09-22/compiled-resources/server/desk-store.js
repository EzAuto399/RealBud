// Encrypted Desk store. On-disk authority is V3 after open; Desk mutates a V2 working copy.
import { closeSync, constants, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_RETENTION_DAYS } from "../shared/office.js";
import { emptyV3 } from "../shared/desk-v3.js";
import { writeFileAtomic } from "./atomic.js";
import { encryptJson } from "./desk-crypto.js";
import { loadDeskKey } from "./desk-key.js";
import { commitOrRecover } from "./desk-v3-commit.js";
import { migrateV2ToV3 } from "./desk-v3-migrate.js";
import { projectWorkingV2 } from "./desk-v3-project.js";
import { idleRecovery } from "./desk-v3-recovery.js";
import { ensureDemoBreadth } from "./desk-v3-demo-breadth.js";
import { syncWorkingV2IntoV3 } from "./desk-v3-sync.js";
import { validateDeskV3 } from "./desk-v3-decode.js";
import { findRestorableQuarantine, restoreQuarantineToDesk } from "./desk-auto-restore.js";
const MAX_BACKUPS = 5;
export const STORAGE_FULL_MESSAGE = "This Mac is out of space. Nothing was lost; the last good book is kept. Free space and try again.";
function isStorageFullCode(code) {
    return code === "ENOSPC" || code === "EDQUOT";
}
function throwStorageWriteError(error) {
    const code = error?.code;
    if (isStorageFullCode(code)) {
        throw Object.assign(new Error(STORAGE_FULL_MESSAGE), { status: 507, code: "storage-full" });
    }
    throw error;
}
function hostTimezone() {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Australia/Sydney";
}
export function emptyV2(book) {
    return {
        version: 2,
        revision: 1,
        mode: "demo",
        timezone: hostTimezone(),
        retentionDays: DEFAULT_RETENTION_DAYS,
        properties: book.properties,
        ledger: book.ledger,
        drafts: [],
        escalations: [],
        workItems: [],
        lastRunAt: null,
        results: [],
        hands: "demo",
        handsDetail: null,
        sources: [
            {
                id: "src-demo",
                kind: "demo",
                label: "Demo training book",
                stableKey: "demo:training-book",
            },
        ],
        observations: [],
        portalBindings: [],
        recipes: [],
        capabilities: [],
    };
}
export class DeskStore {
    file;
    backupDir;
    keyInfo;
    batchDepth = 0;
    batchNeedsBump = false;
    /** Tests replace this to simulate a full disk without filling the machine. */
    static atomicWrite = writeFileAtomic;
    /** Recovery escrow: the book's key as hex, for the You-page reveal/copy
     * and the unlock flow. Session-gated routes only. */
    get keyHex() {
        return this.keyInfo.key.toString("hex");
    }
    get keyFile() {
        return join(dirname(this.file), "desk.key");
    }
    data;
    v3;
    recovery;
    constructor(opts) {
        this.file = opts.file;
        this.backupDir = join(dirname(opts.file), "desk-backups");
        this.keyInfo = loadDeskKey({ dir: dirname(opts.file), key: opts.key });
        const loaded = this.read(opts.book);
        this.data = loaded.data;
        this.v3 = loaded.v3;
        this.recovery = loaded.recovery;
        this.protectOwnedFile();
    }
    /** Re-read desk.json after an unlock restored files on disk. */
    reopen(book, key) {
        this.keyInfo = key && key.length === 32
            ? { key, source: "inline", production: this.keyInfo.production }
            : loadDeskKey({ dir: dirname(this.file) });
        const loaded = this.read(book);
        this.data = loaded.data;
        this.v3 = loaded.v3;
        this.recovery = loaded.recovery;
        this.protectOwnedFile();
        this.keyInfo = loaded.key;
    }
    read(book) {
        let restoredOnce = false;
        for (;;) {
            if (!existsSync(this.file)) {
                if (!restoredOnce) {
                    const candidate = findRestorableQuarantine(this.keyInfo.key, this.file);
                    if (candidate) {
                        restoreQuarantineToDesk(candidate, this.file);
                        restoredOnce = true;
                        continue;
                    }
                }
                const fresh = emptyV2(book);
                const v3 = ensureDemoBreadth(migrateV2ToV3(fresh, Date.now()), Date.now());
                this.writeV3(v3);
                return { data: projectWorkingV2(v3), v3, recovery: idleRecovery(), key: this.keyInfo };
            }
            const result = commitOrRecover({
                file: this.file,
                key: this.keyInfo.key,
                migratedAt: Date.now(),
                book,
                // Only consulted for a legacy V1 book, which carries no timezone. Stamp the
                // host zone like the fresh-book paths; never a fixed Australian default.
                timezone: hostTimezone(),
            });
            if (!result.ok) {
                const quarantined = [...result.recovery.quarantined];
                if (result.phase === "decode" || result.phase === "retain-bytes") {
                    const quarantine = `${this.file}.quarantine-${Date.now()}`;
                    try {
                        renameSync(this.file, quarantine);
                        quarantined.push(quarantine);
                    }
                    catch {
                        /* already gone */
                    }
                }
                if (!restoredOnce) {
                    const candidate = findRestorableQuarantine(this.keyInfo.key, this.file, quarantined);
                    if (candidate) {
                        restoreQuarantineToDesk(candidate, this.file);
                        restoredOnce = true;
                        continue;
                    }
                }
                const empty = emptyV2({ properties: [], ledger: [] });
                empty.mode = "live";
                empty.hands = "held";
                empty.handsDetail = "Desk is in recovery — the book was not replaced with Demo data.";
                return {
                    data: empty,
                    v3: emptyV3({ name: "", timezone: hostTimezone(), jurisdictions: [] }),
                    recovery: { ...result.recovery, quarantined },
                    key: this.keyInfo,
                };
            }
            const opened = result.v3.mode === "demo" ? ensureDemoBreadth(result.v3, Date.now()) : result.v3;
            if (opened !== result.v3 || opened.mode === "demo") {
                const before = result.v3.cases.length + result.v3.contacts.length + result.v3.tenancies.length;
                const after = opened.cases.length + opened.contacts.length + opened.tenancies.length;
                if (after !== before)
                    this.writeV3(opened);
            }
            return { data: projectWorkingV2(opened), v3: opened, recovery: idleRecovery(), key: this.keyInfo };
        }
    }
    persist() {
        if (this.recovery.active) {
            throw Object.assign(new Error("desk is read-only in recovery mode"), { status: 409 });
        }
        if (this.batchDepth > 0) {
            this.batchNeedsBump = true;
            return;
        }
        this.commitWithBump();
    }
    persistWithoutBump() {
        if (this.recovery.active) {
            throw Object.assign(new Error("desk is read-only in recovery mode"), { status: 409 });
        }
        if (this.batchDepth > 0) {
            this.batchNeedsBump = true;
            return;
        }
        this.flushV3();
    }
    /** One encrypt/fsync/backup at the end. Nested calls share the same write. */
    runBatch(fn) {
        this.batchDepth += 1;
        try {
            return fn();
        }
        finally {
            this.batchDepth -= 1;
            if (this.batchDepth === 0 && this.batchNeedsBump) {
                this.batchNeedsBump = false;
                if (!this.recovery.active)
                    this.commitWithBump();
            }
        }
    }
    /** Replay only the sample book. Publish one complete replacement or keep
     * both in-memory projections and the durable book exactly as they were. */
    replaySample(book, now, prepare) {
        if (this.recovery.active || this.data.mode !== "demo") {
            throw Object.assign(new Error("Sample replay is only available on the sample book. Your office book has been kept."), { status: 409 });
        }
        if (this.batchDepth !== 0)
            throw new Error("Sample replay cannot run inside another book operation");
        const previousData = this.data;
        const previousV3 = this.v3;
        const fresh = emptyV2(book);
        fresh.revision = previousData.revision;
        fresh.timezone = previousData.timezone;
        fresh.retentionDays = previousData.retentionDays;
        fresh.recipes = structuredClone(previousData.recipes);
        const ids = new Set(book.properties.map(property => property.id));
        fresh.portalBindings = structuredClone(previousData.portalBindings.filter(binding => ids.has(binding.propertyId)));
        this.data = fresh;
        this.v3 = ensureDemoBreadth(migrateV2ToV3(fresh, now), now);
        this.v3.agency = structuredClone(previousV3.agency);
        this.v3.office = structuredClone(previousV3.office);
        this.batchDepth = 1;
        try {
            prepare();
            this.batchDepth = 0;
            this.batchNeedsBump = false;
            this.commitWithBump();
        }
        catch (error) {
            this.data = previousData;
            this.v3 = previousV3;
            throw error;
        }
        finally {
            this.batchDepth = 0;
            this.batchNeedsBump = false;
        }
    }
    commitWithBump() {
        const previousRevision = this.data.revision;
        const previousV3 = this.v3;
        this.data.revision += 1;
        try {
            this.flushV3();
        }
        catch (error) {
            this.data.revision = previousRevision;
            this.v3 = previousV3;
            throw error;
        }
        this.rotateBackup();
    }
    flushV3() {
        this.v3 = ensureDemoBreadth(syncWorkingV2IntoV3(this.v3, this.data, Date.now()), Date.now());
        validateDeskV3(this.v3);
        this.writeV3(this.v3);
    }
    /** Older atomic writes inherited the process umask. Tighten only this
     * owned, unlinked regular file by handle; never rewrite historical bytes. */
    protectOwnedFile() {
        if (process.platform === 'win32' || !existsSync(this.file))
            return;
        const before = lstatSync(this.file);
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== process.getuid?.() || !(before.mode & 0o077))
            return;
        const handle = openSync(this.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
            const current = fstatSync(handle);
            if (current.isFile() && current.nlink === 1 && current.dev === before.dev && current.ino === before.ino && current.uid === before.uid)
                fchmodSync(handle, 0o600);
        }
        finally {
            closeSync(handle);
        }
    }
    writeV3(v3) {
        mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
        try {
            DeskStore.atomicWrite(this.file, JSON.stringify(encryptJson(this.keyInfo.key, v3)), 0o600);
        }
        catch (error) {
            throwStorageWriteError(error);
        }
    }
    rotateBackup() {
        try {
            mkdirSync(this.backupDir, { recursive: true, mode: 0o700 });
            const dest = join(this.backupDir, `desk-${this.data.revision}.json`);
            writeFileAtomic(dest, readFileSync(this.file, "utf8"), 0o600);
            const files = readdirSync(this.backupDir)
                .filter((name) => name.startsWith("desk-"))
                .sort();
            while (files.length > MAX_BACKUPS) {
                const oldest = files.shift();
                if (oldest)
                    renameSync(join(this.backupDir, oldest), join(this.backupDir, `purged-${oldest}`));
            }
        }
        catch {
            /* backup is best-effort */
        }
    }
    snapshotExtras() {
        return {
            version: 2,
            revision: this.data.revision,
            mode: this.data.mode,
            recovery: this.recovery,
            timezone: this.data.timezone,
            retentionDays: this.data.retentionDays,
            workItems: this.data.workItems,
            sources: this.data.sources,
            demo: this.data.mode === "demo",
        };
    }
}
