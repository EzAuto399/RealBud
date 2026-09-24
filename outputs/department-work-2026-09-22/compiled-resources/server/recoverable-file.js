import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { fsyncDir, writeFileAtomic } from "./atomic.js";
/** A durable state file was present but could not be verified or restored.
 * Callers must keep the affected feature read-only and preserve the bytes. */
export class RecoveryRequiredError extends Error {
    status = 409;
    code = "local-state-recovery-required";
    constructor(message = "Local state needs recovery before this change can be saved.") {
        super(message);
        this.name = "RecoveryRequiredError";
    }
}
export function previousFile(path) {
    return `${path}.previous`;
}
export function quarantineFile(path) {
    return `${path}.quarantine`;
}
function readRaw(path) {
    try {
        return { kind: "ok", raw: readFileSync(path, "utf8") };
    }
    catch (error) {
        return error?.code === "ENOENT"
            ? { kind: "missing" }
            : { kind: "unreadable" };
    }
}
function decodeRaw(raw, decode) {
    try {
        return { ok: true, value: decode(raw) };
    }
    catch {
        return { ok: false };
    }
}
/** Read a state file without ever interpreting corrupt or incompatible bytes
 * as an empty first run. A verified one-generation backup is restored
 * automatically; otherwise the original is left untouched and blocked. */
export function readRecoverableFile(path, decode) {
    const current = readRaw(path);
    if (current.kind === "ok") {
        const decoded = decodeRaw(current.raw, decode);
        if (decoded.ok)
            return { value: decoded.value, state: "current" };
    }
    else if (current.kind === "unreadable") {
        return { value: null, state: "blocked", reason: "unreadable" };
    }
    const previous = readRaw(previousFile(path));
    if (previous.kind === "unreadable") {
        return { value: null, state: "blocked", reason: "unreadable" };
    }
    if (previous.kind === "missing") {
        if (current.kind === "missing")
            return { value: null, state: "missing" };
        return { value: null, state: "blocked", reason: "current-invalid" };
    }
    const decodedPrevious = decodeRaw(previous.raw, decode);
    if (!decodedPrevious.ok) {
        return { value: null, state: "blocked", reason: "previous-invalid" };
    }
    try {
        mkdirSync(dirname(path), { recursive: true });
        // Preserve an invalid current generation before replacing it. A missing
        // current generation needs no quarantine; the previous file is already
        // the retained evidence.
        if (current.kind === "ok")
            writeFileAtomic(quarantineFile(path), current.raw);
        writeFileAtomic(path, previous.raw);
        return {
            value: decodedPrevious.value,
            state: "restored",
            reason: current.kind === "missing" ? "current-missing" : "current-invalid",
        };
    }
    catch {
        return { value: null, state: "blocked", reason: "restore-failed" };
    }
}
/** Replace a verified state file while retaining exactly one verified prior
 * generation. If the current generation is corrupt, refuse to overwrite it. */
export function writeRecoverableFile(path, raw, decode) {
    if (!decodeRaw(raw, decode).ok)
        throw new Error("refusing to persist invalid local state");
    const existing = readRecoverableFile(path, decode);
    if (existing.state === "blocked")
        throw new RecoveryRequiredError();
    mkdirSync(dirname(path), { recursive: true });
    if (existing.state === "current" || existing.state === "restored") {
        // Re-read the exact verified generation so formatting and encrypted
        // envelopes are preserved byte-for-byte in the backup.
        writeFileAtomic(previousFile(path), readFileSync(path, "utf8"));
    }
    writeFileAtomic(path, raw);
}
/** Explicit product deletion removes all generations for that exact file.
 * This is intentionally not used for recovery or startup cleanup. */
export function deleteRecoverableFile(path) {
    let changed = false;
    for (const candidate of [path, previousFile(path), quarantineFile(path)]) {
        if (!existsSync(candidate))
            continue;
        unlinkSync(candidate);
        changed = true;
    }
    if (changed)
        fsyncDir(dirname(path));
}
