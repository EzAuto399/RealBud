import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "./atomic.js";
import { decryptJson, encryptJson, isEncryptedEnvelope } from "./desk-crypto.js";
import { RecoveryRequiredError, deleteRecoverableFile, readRecoverableFile, writeRecoverableFile, } from "./recoverable-file.js";
const SECRET_FILE = "secrets.json";
const DEV_KEY_FILE = ".secrets.key";
let cachedProcessKey = null;
function strictKey(value) {
    return value?.length === 32 ? Buffer.from(value) : null;
}
function readHexKey(path) {
    try {
        const raw = readFileSync(path);
        if (raw.length === 32)
            return raw;
        const text = raw.toString("utf8").trim();
        return /^[0-9a-f]{64}$/i.test(text) ? Buffer.from(text, "hex") : null;
    }
    catch {
        return null;
    }
}
function secretKey(opts) {
    const supplied = strictKey(opts.key);
    if (supplied)
        return supplied;
    const fromEnv = process.env.REALBUD_SECRET_KEY;
    if (fromEnv && /^[0-9a-f]{64}$/i.test(fromEnv)) {
        cachedProcessKey = Buffer.from(fromEnv, "hex");
        return Buffer.from(cachedProcessKey);
    }
    if (cachedProcessKey)
        return Buffer.from(cachedProcessKey);
    const production = opts.production ?? process.env.REALBUD_PRODUCTION === "1";
    if (production) {
        throw new Error("production secret storage is unavailable");
    }
    mkdirSync(opts.dir, { recursive: true });
    const keyPath = join(opts.dir, DEV_KEY_FILE);
    const existing = readHexKey(keyPath);
    if (existing)
        return existing;
    const generated = randomBytes(32);
    // Development/source runs remain explicitly non-production. The file is
    // private to the isolated test/data directory and is never used by a
    // packaged build, where Electron must provide an OS-wrapped key.
    writeFileSync(keyPath, generated, { mode: 0o600, flag: "wx" });
    return generated;
}
function validateName(name) {
    if (!/^[A-Za-z0-9._-]{1,160}$/.test(name))
        throw new Error("secret name is invalid");
}
export class SecretStore {
    path;
    key;
    constructor(opts) {
        this.path = join(opts.dir, SECRET_FILE);
        this.key = secretKey(opts);
    }
    decode(raw) {
        const encoded = JSON.parse(raw);
        if (!isEncryptedEnvelope(encoded))
            throw new Error("secret store is not encrypted");
        const plain = decryptJson(this.key, encoded);
        if (plain.version !== 1 || !plain.values || typeof plain.values !== "object" || Array.isArray(plain.values)) {
            throw new Error("secret store is invalid");
        }
        const values = {};
        for (const [name, value] of Object.entries(plain.values)) {
            validateName(name);
            if (typeof value !== "string" || value.length > 65_536 || value.includes("\0")) {
                throw new Error("secret store contains an invalid value");
            }
            values[name] = value;
        }
        return { version: 1, values };
    }
    read() {
        const result = readRecoverableFile(this.path, (raw) => this.decode(raw));
        if (result.state === "blocked") {
            throw new RecoveryRequiredError("Encrypted settings need recovery before credentials can be read or changed.");
        }
        return result.value ?? { version: 1, values: {} };
    }
    get(name) {
        validateName(name);
        return this.read().values[name] ?? null;
    }
    has(name) {
        return this.get(name) !== null;
    }
    set(name, value) {
        this.commitPrepared(this.prepareUpdate({ [name]: value }));
    }
    delete(name) {
        this.commitPrepared(this.prepareUpdate({ [name]: null }));
    }
    /** Prepare a single encrypted replacement without exposing plaintext in a
     * journal. Config can atomically coordinate this ciphertext with its
     * public settings file. */
    prepareUpdate(changes) {
        const file = this.read();
        const beforeRaw = existsSync(this.path) ? readFileSync(this.path, "utf8") : null;
        let changed = false;
        for (const [name, value] of Object.entries(changes)) {
            validateName(name);
            if (value === null) {
                if (name in file.values) {
                    delete file.values[name];
                    changed = true;
                }
                continue;
            }
            if (typeof value !== "string" || !value || value.length > 65_536 || value.includes("\0")) {
                throw new Error("secret value is invalid");
            }
            if (file.values[name] !== value) {
                file.values[name] = value;
                changed = true;
            }
        }
        return {
            beforeRaw,
            afterRaw: changed || beforeRaw === null ? JSON.stringify(encryptJson(this.key, file)) : beforeRaw,
            changed,
        };
    }
    commitPrepared(update) {
        if (!update.changed)
            return;
        const current = this.snapshotRaw();
        if (current !== update.beforeRaw) {
            throw Object.assign(new Error("encrypted settings changed while this update was being prepared"), {
                status: 409,
                code: "stale-secret-update",
            });
        }
        // Decode before writing so a caller cannot smuggle an unencrypted or
        // incompatible payload through the prepared-update API.
        this.decode(update.afterRaw);
        writeRecoverableFile(this.path, update.afterRaw, (raw) => this.decode(raw));
        try {
            chmodSync(this.path, 0o600);
        }
        catch {
            /* best effort on Windows */
        }
    }
    snapshotRaw() {
        this.read();
        return existsSync(this.path) ? readFileSync(this.path, "utf8") : null;
    }
    /** Restore only ciphertext captured by snapshotRaw/prepareUpdate. */
    restoreRaw(raw) {
        if (raw === null) {
            deleteRecoverableFile(this.path);
            return;
        }
        this.decode(raw);
        mkdirSync(dirname(this.path), { recursive: true });
        writeFileAtomic(this.path, raw);
    }
}
