import { chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { localSessionFor, readLocalSession } from "./local-session.mjs";

const TOKEN = "5".repeat(48);
const directories: string[] = [];
function dataDirectory(record: unknown = { version: 1, pid: 4242, port: 8799, token: TOKEN }, mode = 0o600): string {
  const directory = mkdtempSync(join(tmpdir(), "realbud-local-session-"));
  directories.push(directory);
  mkdirSync(join(directory, "local-auth"), { mode: 0o700 });
  writeFileSync(join(directory, "local-auth", "session.json"), JSON.stringify(record), { mode });
  chmodSync(join(directory, "local-auth", "session.json"), mode);
  return directory;
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe.skipIf(process.platform === "win32")("local session file", () => {
  it("returns the token only for the exact process that owns the port", async () => {
    const directory = dataDirectory();
    expect(await localSessionFor(directory, { port: 8799, body: { pid: 4242 } })).toBe(TOKEN);
    expect(await localSessionFor(directory, { port: 18799, body: { pid: 4242 } })).toBeNull();
    expect(await localSessionFor(directory, { port: 8799, body: { pid: 4243 } })).toBeNull();
    expect(await localSessionFor(directory, null)).toBeNull();
  });

  it("reports an unpublished session as absent", async () => {
    const directory = mkdtempSync(join(tmpdir(), "realbud-local-session-"));
    directories.push(directory);
    expect(await readLocalSession(directory)).toBeNull();
  });

  it("fails closed on a loose mode, a link, a loose directory or a malformed record", async () => {
    await expect(readLocalSession(dataDirectory(undefined, 0o644))).rejects.toThrow("not private");
    const linked = dataDirectory();
    linkSync(join(linked, "local-auth", "session.json"), join(linked, "second-name"));
    await expect(readLocalSession(linked)).rejects.toThrow("not private");
    const symlinked = mkdtempSync(join(tmpdir(), "realbud-local-session-"));
    directories.push(symlinked);
    mkdirSync(join(symlinked, "local-auth"), { mode: 0o700 });
    symlinkSync(join(dataDirectory(), "local-auth", "session.json"), join(symlinked, "local-auth", "session.json"));
    await expect(readLocalSession(symlinked)).rejects.toThrow("not private");
    const looseDirectory = dataDirectory();
    chmodSync(join(looseDirectory, "local-auth"), 0o755);
    await expect(readLocalSession(looseDirectory)).rejects.toThrow("not private");
    for (const record of [{ version: 1, pid: 1, port: 8799, token: "short" }, { version: 2, pid: 1, port: 8799, token: TOKEN }, null])
      await expect(readLocalSession(dataDirectory(record))).rejects.toThrow("needs recovery");
  });
});
