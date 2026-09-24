import { createHash, randomUUID } from "node:crypto";
import { constants, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { lstat, open, rm } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { DATA_DIR } from "./config.js";
export const MAX_SELECTED_FILE_BATCH_BYTES = 100 * 1024 * 1024;
const COPY_BUFFER_BYTES = 64 * 1024;
const TURN_PREFIX = "turn-";
function workspaceError(message) {
    return Object.assign(new Error(message), { status: 400, code: "selected-file-staging-failed" });
}
function workspaceRoot(root) {
    return root ?? join(DATA_DIR, "workspaces", "selected-files");
}
function safeFileName(name, index) {
    const base = basename(name)
        .normalize("NFKC")
        .replace(/[\u0000-\u001f\u007f]/g, "_")
        .replace(/[^\p{L}\p{N} ._()-]/gu, "_")
        .trim();
    const extension = extname(base).slice(0, 20);
    const stem = (extension ? base.slice(0, -extension.length) : base).slice(0, 90).trim() || "selected-file";
    return `${String(index + 1).padStart(3, "0")}-${stem}${extension}`;
}
/**
 * A previous process cannot still own a turn after RealBud has acquired the
 * single-instance data-directory lock. Remove only our exact private turn
 * directories; unrelated files under the parent are deliberately preserved.
 */
export function recoverSelectedFileWorkspaces(root) {
    const parent = workspaceRoot(root);
    if (!existsSync(parent))
        return 0;
    let removed = 0;
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^turn-[A-Za-z0-9_-]+$/.test(entry.name))
            continue;
        rmSync(join(parent, entry.name), { recursive: true, force: true });
        removed += 1;
    }
    return removed;
}
/** Copy only the already-authorized attachment descriptors into a private,
 * short-lived workspace. The source file is opened without following a new
 * symlink and checked before/after copying so a path swap cannot silently
 * widen the selected input. */
export async function stageSelectedFileWorkspace(selected, options = {}) {
    if (!selected.length)
        throw workspaceError("select at least one file to review");
    const maxBytes = options.maxBytes ?? MAX_SELECTED_FILE_BATCH_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
        throw workspaceError("selected-file size limit is invalid");
    if (selected.reduce((total, file) => total + file.size, 0) > maxBytes) {
        throw workspaceError(`selected files must total ${Math.floor(maxBytes / 1024 / 1024)} MB or less`);
    }
    const parent = workspaceRoot(options.root);
    const suffix = (options.idFactory ?? randomUUID)().replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
    if (!suffix)
        throw workspaceError("selected-file workspace id is invalid");
    const directory = join(parent, `${TURN_PREFIX}${suffix}`);
    try {
        mkdirSync(parent, { recursive: true, mode: 0o700 });
        mkdirSync(directory, { mode: 0o700 });
    }
    catch {
        throw workspaceError("RealBud could not prepare a private selected-file workspace");
    }
    const staged = [];
    const inputDigests = [];
    let cleaned = false;
    const cleanup = async () => {
        if (cleaned)
            return;
        cleaned = true;
        await rm(directory, { recursive: true, force: true });
    };
    try {
        let copiedTotal = 0;
        for (const [index, attachment] of selected.entries()) {
            const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
            const pathState = await lstat(attachment.path);
            if (pathState.isSymbolicLink()) {
                throw workspaceError("a selected file changed before it could be reviewed; select it again");
            }
            const source = await open(attachment.path, constants.O_RDONLY | noFollow);
            let destination = null;
            try {
                const before = await source.stat();
                if (!before.isFile() || before.size !== attachment.size) {
                    throw workspaceError("a selected file changed before it could be reviewed; select it again");
                }
                copiedTotal += before.size;
                if (copiedTotal > maxBytes)
                    throw workspaceError("selected files exceed the review size limit");
                const target = join(directory, safeFileName(attachment.name, index));
                destination = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
                const digest = createHash("sha256");
                const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
                let position = 0;
                for (;;) {
                    const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
                    if (!bytesRead)
                        break;
                    await destination.write(buffer, 0, bytesRead, position);
                    digest.update(buffer.subarray(0, bytesRead));
                    position += bytesRead;
                    if (position > before.size || position > maxBytes) {
                        throw workspaceError("a selected file changed while it was being reviewed; select it again");
                    }
                }
                await destination.sync();
                const after = await source.stat();
                if (position !== before.size
                    || after.size !== before.size
                    || after.mtimeMs !== before.mtimeMs
                    || after.ctimeMs !== before.ctimeMs) {
                    throw workspaceError("a selected file changed while it was being reviewed; select it again");
                }
                staged.push({
                    path: target,
                    name: attachment.name,
                    size: before.size,
                    mimeType: attachment.mimeType,
                });
                inputDigests.push(digest.digest("hex"));
            }
            finally {
                await destination?.close().catch(() => { });
                await source.close().catch(() => { });
            }
        }
        return { directory, attachments: staged, inputDigests, cleanup };
    }
    catch (error) {
        await cleanup();
        if (error.code === "ELOOP") {
            throw workspaceError("a selected file changed before it could be reviewed; select it again");
        }
        if (error.code === "selected-file-staging-failed")
            throw error;
        throw workspaceError("RealBud could not prepare the selected files; select them again");
    }
}
