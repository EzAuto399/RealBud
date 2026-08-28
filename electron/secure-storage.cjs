const { randomBytes, randomUUID } = require("node:crypto");
const {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} = require("node:fs");
const path = require("node:path");

const STORE_VERSION = 1;
const STORE_FILE = "secure-keys.json";

function readLegacyKey(file) {
  if (!existsSync(file)) return null;
  const raw = readFileSync(file);
  if (raw.length === 32) return raw.toString("hex");
  const text = raw.toString("utf8").trim();
  return /^[0-9a-f]{64}$/i.test(text) ? text.toLowerCase() : null;
}

function writeAtomic(file, body) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let fd = null;
  try {
    fd = openSync(temp, "w", 0o600);
    writeFileSync(fd, body, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temp, file);
    const dir = openSync(path.dirname(file), "r");
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  } catch (error) {
    if (fd !== null) {
      try { closeSync(fd); } catch {}
    }
    try { unlinkSync(temp); } catch {}
    throw error;
  }
}

function readStore(file) {
  if (!existsSync(file)) return { version: STORE_VERSION, keys: {} };
  const value = JSON.parse(readFileSync(file, "utf8"));
  if (!value || value.version !== STORE_VERSION || !value.keys || typeof value.keys !== "object") {
    throw new Error("secure key record is invalid");
  }
  return value;
}

async function decryptKey(safeStorage, encoded) {
  const result = await safeStorage.decryptStringAsync(Buffer.from(encoded, "base64"));
  const value = typeof result === "string" ? result : result?.result;
  if (!/^[0-9a-f]{64}$/i.test(value ?? "")) throw new Error("secure key record could not be verified");
  return { value: value.toLowerCase(), shouldReEncrypt: Boolean(result?.shouldReEncrypt) };
}

async function encryptKey(safeStorage, value) {
  return (await safeStorage.encryptStringAsync(value)).toString("base64");
}

/**
 * Prepare the two wrapping keys the server needs. The encrypted record is
 * verified before any legacy plaintext key is removed. A packaged build
 * refuses Linux's `basic_text` fallback unless an explicit package-smoke
 * flag is present.
 */
async function prepareSecureRuntimeEnv({ safeStorage, dataDir, platform = process.platform, allowInsecureTest = false }) {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    throw new Error("operating-system credential storage is unavailable");
  }
  if (
    platform === "linux" &&
    typeof safeStorage.getSelectedStorageBackend === "function" &&
    safeStorage.getSelectedStorageBackend() === "basic_text" &&
    !allowInsecureTest
  ) {
    throw new Error("Linux credential storage fell back to unprotected basic_text");
  }

  mkdirSync(dataDir, { recursive: true });
  const storePath = path.join(dataDir, STORE_FILE);
  const record = readStore(storePath);
  const legacy = {
    desk: path.join(dataDir, "desk.key"),
    secrets: path.join(dataDir, ".secrets.key"),
  };
  const plain = {};
  let changed = false;

  for (const [name, legacyPath] of Object.entries(legacy)) {
    const encoded = record.keys[name];
    if (typeof encoded === "string" && encoded) {
      const decoded = await decryptKey(safeStorage, encoded);
      plain[name] = decoded.value;
      if (decoded.shouldReEncrypt) {
        record.keys[name] = await encryptKey(safeStorage, decoded.value);
        changed = true;
      }
      continue;
    }
    const value = readLegacyKey(legacyPath) ?? randomBytes(32).toString("hex");
    plain[name] = value;
    record.keys[name] = await encryptKey(safeStorage, value);
    changed = true;
  }

  if (changed || !existsSync(storePath)) writeAtomic(storePath, `${JSON.stringify(record)}\n`);

  // Read the durable record back through the OS before deleting old keys.
  const durable = readStore(storePath);
  for (const name of Object.keys(legacy)) {
    const checked = await decryptKey(safeStorage, durable.keys[name]);
    if (checked.value !== plain[name]) throw new Error("secure key write verification failed");
  }
  for (const legacyPath of Object.values(legacy)) {
    try { unlinkSync(legacyPath); } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  return {
    REALBUD_DESK_KEY: plain.desk,
    REALBUD_SECRET_KEY: plain.secrets,
    REALBUD_PRODUCTION: "1",
  };
}

module.exports = { prepareSecureRuntimeEnv, readLegacyKey };
