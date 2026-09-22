// Restore before importing application stores: their constructors read and
// sometimes recover persisted state. The normal service key never changes.
import { DATA_DIR } from "./config.js";
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { windowsFilePrivacy } from "./windows-file-privacy.js";
import { applyStagedPrivateRestore, PRIVATE_RESTORE_STAGE_FILE } from "./private-workspace-backup.js";
import { applyStagedPrivateRestoreV2, PRIVATE_RESTORE_V2_STAGE_FILE } from "./private-backup-cold-restore.js";
const v1Restore = existsSync(join(DATA_DIR, PRIVATE_RESTORE_STAGE_FILE));
const v2Restore = existsSync(join(DATA_DIR, PRIVATE_RESTORE_V2_STAGE_FILE));
if (v1Restore && v2Restore)
    throw new Error('Conflicting private restores need recovery. Startup remains held; both restore records were preserved.');
if (v1Restore || v2Restore) {
    let key;
    if (process.env.REALBUD_DESK_KEY) {
        if (!/^[a-fA-F0-9]{64}$/.test(process.env.REALBUD_DESK_KEY))
            throw new Error('The staged restore needs its original destination key.');
        key = Buffer.from(process.env.REALBUD_DESK_KEY, 'hex');
    }
    else {
        const path = join(DATA_DIR, 'desk.key'), stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())))
            throw new Error('The staged restore key needs recovery.');
        await windowsFilePrivacy(path, 'file');
        const bytes = readFileSync(path);
        if (bytes.length === 32)
            key = bytes;
        else if (bytes.length === 64 && /^[a-fA-F0-9]{64}$/.test(bytes.toString()))
            key = Buffer.from(bytes.toString(), 'hex');
        else
            throw new Error('The staged restore key needs recovery.');
    }
    try {
        if (v2Restore)
            await applyStagedPrivateRestoreV2({ directory: DATA_DIR, key });
        else
            await applyStagedPrivateRestore({ directory: DATA_DIR, key });
    }
    finally {
        key.fill(0);
    }
}
process.env.REALBUD_RESTORE_BOOTSTRAP = '1';
await import("./index.js");
