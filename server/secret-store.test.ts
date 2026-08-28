import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { isEncryptedEnvelope } from "./desk-crypto.ts";
import { SecretStore } from "./secret-store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "realbud-secrets-"));
  dirs.push(dir);
  return dir;
}

describe("encrypted secret store", () => {
  it("never writes the credential in plaintext", () => {
    const dir = tempDir();
    const store = new SecretStore({ dir, key: Buffer.alloc(32, 7), production: true });
    store.set("worker.XAI_API_KEY", "private-provider-value");
    const raw = readFileSync(store.path, "utf8");
    expect(raw).not.toContain("private-provider-value");
    expect(isEncryptedEnvelope(JSON.parse(raw))).toBe(true);
    expect(store.get("worker.XAI_API_KEY")).toBe("private-provider-value");
  });

  it("supports replacement and deletion", () => {
    const store = new SecretStore({ dir: tempDir(), key: Buffer.alloc(32, 8), production: true });
    store.set("config.composio.key", "first");
    store.set("config.composio.key", "second");
    expect(store.get("config.composio.key")).toBe("second");
    store.delete("config.composio.key");
    expect(store.get("config.composio.key")).toBeNull();
  });

  it("refuses production startup without an OS-supplied wrapping key", () => {
    const previous = process.env.REALBUD_SECRET_KEY;
    delete process.env.REALBUD_SECRET_KEY;
    try {
      expect(() => new SecretStore({ dir: tempDir(), production: true })).toThrow(/unavailable/);
    } finally {
      if (previous === undefined) delete process.env.REALBUD_SECRET_KEY;
      else process.env.REALBUD_SECRET_KEY = previous;
    }
  });

  it("fails closed with the wrong key", () => {
    const dir = tempDir();
    new SecretStore({ dir, key: Buffer.alloc(32, 9), production: true }).set("worker.OPENAI_API_KEY", "secret");
    expect(() => new SecretStore({ dir, key: Buffer.alloc(32, 10), production: true }).get("worker.OPENAI_API_KEY")).toThrow();
  });
});
