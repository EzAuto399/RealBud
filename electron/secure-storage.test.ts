import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { prepareSecureRuntimeEnv } = require("./secure-storage.cjs") as {
  prepareSecureRuntimeEnv(input: {
    safeStorage: ReturnType<typeof fakeSafeStorage>;
    dataDir: string;
    platform?: NodeJS.Platform;
    allowInsecureTest?: boolean;
  }): Promise<Record<string, string>>;
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "realbud-safe-storage-"));
  dirs.push(dir);
  return dir;
}

function fakeSafeStorage(backend = "gnome_libsecret") {
  return {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => backend,
    encryptStringAsync: async (value: string) => Buffer.from(`protected:${value}`, "utf8"),
    decryptStringAsync: async (value: Buffer) => ({
      result: value.toString("utf8").replace(/^protected:/, ""),
      shouldReEncrypt: false,
    }),
  };
}

describe("Electron OS-backed key preparation", () => {
  it("migrates and removes legacy plaintext keys only after verification", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "desk.key"), Buffer.alloc(32, 1));
    writeFileSync(join(dir, ".secrets.key"), Buffer.alloc(32, 2));
    const env = await prepareSecureRuntimeEnv({ safeStorage: fakeSafeStorage(), dataDir: dir, platform: "darwin" });
    expect(env.REALBUD_DESK_KEY).toBe(Buffer.alloc(32, 1).toString("hex"));
    expect(env.REALBUD_SECRET_KEY).toBe(Buffer.alloc(32, 2).toString("hex"));
    expect(() => readFileSync(join(dir, "desk.key"))).toThrow();
    expect(() => readFileSync(join(dir, ".secrets.key"))).toThrow();
    const raw = readFileSync(join(dir, "secure-keys.json"), "utf8");
    expect(raw).not.toContain(env.REALBUD_DESK_KEY);
    expect(raw).not.toContain(env.REALBUD_SECRET_KEY);
  });

  it("reopens with stable keys instead of generating replacements", async () => {
    const dir = tempDir();
    const first = await prepareSecureRuntimeEnv({ safeStorage: fakeSafeStorage(), dataDir: dir, platform: "win32" });
    const second = await prepareSecureRuntimeEnv({ safeStorage: fakeSafeStorage(), dataDir: dir, platform: "win32" });
    expect(second).toEqual(first);
  });

  it("refuses unavailable or unprotected production storage", async () => {
    const unavailable = fakeSafeStorage();
    unavailable.isAsyncEncryptionAvailable = async () => false;
    await expect(prepareSecureRuntimeEnv({ safeStorage: unavailable, dataDir: tempDir(), platform: "darwin" })).rejects.toThrow(/unavailable/);
    await expect(
      prepareSecureRuntimeEnv({ safeStorage: fakeSafeStorage("basic_text"), dataDir: tempDir(), platform: "linux" }),
    ).rejects.toThrow(/basic_text/);
  });

  it("permits basic_text only for an explicit package smoke", async () => {
    await expect(
      prepareSecureRuntimeEnv({
        safeStorage: fakeSafeStorage("basic_text"),
        dataDir: tempDir(),
        platform: "linux",
        allowInsecureTest: true,
      }),
    ).resolves.toMatchObject({ REALBUD_PRODUCTION: "1" });
  });
});
