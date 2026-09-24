import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { AtomicWriteError, writeFileAtomic } from "./atomic.js";
import { DATA_DIR } from "./config.js";
import { decryptJson, encryptJson, isEncryptedEnvelope } from "./desk-crypto.js";
import { loadDeskKey } from "./desk-key.js";
const FILE_KIND = "realbud.work-output.v1";
const SCHEMA_VERSION = 1;
const MAX_OUTPUT_BYTES = 128 * 1024;
const SAFE_RECEIPT_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/;
const SHA256 = /^[a-f0-9]{64}$/;
function codedError(message, code, status = 409) {
    return Object.assign(new Error(message), { code, status });
}
function digest(value) {
    return createHash("sha256").update(value).digest("hex");
}
function exactKeys(value, expected) {
    const keys = Object.keys(value).sort();
    const wanted = [...expected].sort();
    return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
}
function validateReceipt(receipt) {
    if (!SAFE_RECEIPT_ID.test(receipt.id) || !SHA256.test(receipt.requestDigest)) {
        throw codedError("work output receipt authority is invalid", "invalid-work-output", 400);
    }
}
function normalizedFile(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw codedError("encrypted work output is invalid", "work-output-recovery-required", 503);
    }
    const value = raw;
    if (!exactKeys(value, [
        "kind",
        "schemaVersion",
        "receiptId",
        "requestDigest",
        "fencingToken",
        "outputDigest",
        "createdAt",
        "payload",
    ])) {
        throw codedError("encrypted work output has unknown or missing fields", "work-output-recovery-required", 503);
    }
    if (value.kind !== FILE_KIND || value.schemaVersion !== SCHEMA_VERSION) {
        throw codedError("encrypted work output version is unsupported", "work-output-recovery-required", 503);
    }
    if (typeof value.receiptId !== "string" || !SAFE_RECEIPT_ID.test(value.receiptId)) {
        throw codedError("encrypted work output receipt is invalid", "work-output-recovery-required", 503);
    }
    if (typeof value.requestDigest !== "string" || !SHA256.test(value.requestDigest)) {
        throw codedError("encrypted work output request digest is invalid", "work-output-recovery-required", 503);
    }
    if (typeof value.fencingToken !== "number"
        || !Number.isSafeInteger(value.fencingToken)
        || value.fencingToken < 1) {
        throw codedError("encrypted work output fencing token is invalid", "work-output-recovery-required", 503);
    }
    if (typeof value.outputDigest !== "string" || !SHA256.test(value.outputDigest)) {
        throw codedError("encrypted work output digest is invalid", "work-output-recovery-required", 503);
    }
    if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt) || value.createdAt < 0) {
        throw codedError("encrypted work output time is invalid", "work-output-recovery-required", 503);
    }
    let payloadJson;
    try {
        payloadJson = JSON.stringify(value.payload);
    }
    catch {
        throw codedError("encrypted work output payload is invalid", "work-output-recovery-required", 503);
    }
    if (Buffer.byteLength(payloadJson, "utf8") > MAX_OUTPUT_BYTES || digest(payloadJson) !== value.outputDigest) {
        throw codedError("encrypted work output payload does not match its digest", "work-output-recovery-required", 503);
    }
    return {
        kind: FILE_KIND,
        schemaVersion: SCHEMA_VERSION,
        receiptId: value.receiptId,
        requestDigest: value.requestDigest,
        fencingToken: value.fencingToken,
        outputDigest: value.outputDigest,
        createdAt: value.createdAt,
        payload: structuredClone(value.payload),
    };
}
/**
 * Encrypted recoverable outputs for brokered read-only work. The filename is
 * a one-way digest of the receipt id; no property, account, filename or model
 * content appears in paths or plaintext metadata.
 */
export class WorkOutputStore {
    directory;
    key;
    now;
    writer;
    storageUncertain = false;
    constructor(options = {}) {
        const dataDir = options.dir ?? DATA_DIR;
        this.directory = join(dataDir, "work-outputs");
        this.key = loadDeskKey({ dir: dataDir, key: options.key }).key;
        this.now = options.now ?? Date.now;
        this.writer = options.writer ?? writeFileAtomic;
    }
    pathFor(receiptId) {
        if (!SAFE_RECEIPT_ID.test(receiptId)) {
            throw codedError("work output receipt id is invalid", "invalid-work-output", 400);
        }
        return join(this.directory, `work-${digest(receiptId)}.json`);
    }
    read(receipt) {
        validateReceipt(receipt);
        const path = this.pathFor(receipt.id);
        if (!existsSync(path))
            return null;
        let encrypted;
        try {
            encrypted = JSON.parse(readFileSync(path, "utf8"));
        }
        catch {
            throw codedError("encrypted work output could not be read", "work-output-recovery-required", 503);
        }
        if (!isEncryptedEnvelope(encrypted)) {
            throw codedError("work output is not encrypted", "work-output-recovery-required", 503);
        }
        let file;
        try {
            file = normalizedFile(decryptJson(this.key, encrypted));
        }
        catch (error) {
            if (error.code === "work-output-recovery-required")
                throw error;
            throw codedError("encrypted work output could not be authenticated", "work-output-recovery-required", 503);
        }
        if (file.receiptId !== receipt.id || file.requestDigest !== receipt.requestDigest) {
            throw codedError("encrypted work output belongs to different work", "work-output-authority-mismatch", 409);
        }
        return {
            receiptId: file.receiptId,
            requestDigest: file.requestDigest,
            fencingToken: file.fencingToken,
            outputDigest: file.outputDigest,
            createdAt: file.createdAt,
            payload: structuredClone(file.payload),
        };
    }
    persist(input) {
        if (this.storageUncertain) {
            throw codedError("encrypted work output storage is uncertain; restart RealBud before retrying", "work-output-storage-uncertain", 503);
        }
        validateReceipt(input.receipt);
        if (!Number.isSafeInteger(input.fencingToken) || input.fencingToken < 1) {
            throw codedError("work output fencing token is invalid", "invalid-work-output", 400);
        }
        let payloadJson;
        let normalizedPayload;
        try {
            payloadJson = JSON.stringify(input.payload);
            normalizedPayload = payloadJson ? JSON.parse(payloadJson) : undefined;
        }
        catch {
            throw codedError("work output payload is invalid", "invalid-work-output", 400);
        }
        if (!payloadJson || Buffer.byteLength(payloadJson, "utf8") > MAX_OUTPUT_BYTES) {
            throw codedError("work output payload exceeds its safe bound", "invalid-work-output", 400);
        }
        const outputDigest = digest(payloadJson);
        const existing = this.read(input.receipt);
        if (existing) {
            if (existing.fencingToken > input.fencingToken) {
                throw codedError("work output fencing token is stale", "stale-work-output", 409);
            }
            if (existing.fencingToken === input.fencingToken) {
                if (existing.outputDigest !== outputDigest) {
                    throw codedError("work output fence is already bound to different content", "work-output-conflict", 409);
                }
                return { duplicate: true, output: existing };
            }
        }
        const file = {
            kind: FILE_KIND,
            schemaVersion: SCHEMA_VERSION,
            receiptId: input.receipt.id,
            requestDigest: input.receipt.requestDigest,
            fencingToken: input.fencingToken,
            outputDigest,
            createdAt: this.now(),
            payload: normalizedPayload,
        };
        mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        const path = this.pathFor(input.receipt.id);
        const body = JSON.stringify(encryptJson(this.key, file));
        try {
            this.writer(path, body);
        }
        catch (error) {
            if (error instanceof AtomicWriteError && error.disposition === "not-landed") {
                throw codedError("encrypted work output was not written", "work-output-write-failed", 503);
            }
            this.storageUncertain = true;
            throw codedError("encrypted work output durability is uncertain; restart RealBud before retrying", "work-output-storage-uncertain", 503);
        }
        try {
            chmodSync(path, 0o600);
        }
        catch {
            // The authenticated encrypted envelope remains opaque on platforms
            // without POSIX modes; packaged storage still supplies the OS key.
        }
        return {
            duplicate: false,
            output: {
                receiptId: file.receiptId,
                requestDigest: file.requestDigest,
                fencingToken: file.fencingToken,
                outputDigest: file.outputDigest,
                createdAt: file.createdAt,
                payload: structuredClone(file.payload),
            },
        };
    }
    delete(receiptId) {
        const path = this.pathFor(receiptId);
        if (!existsSync(path))
            return false;
        unlinkSync(path);
        return true;
    }
    storageStatus() {
        return this.storageUncertain ? "uncertain" : "ok";
    }
}
