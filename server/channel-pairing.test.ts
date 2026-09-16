import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
const dir = vi.hoisted(() => { const dir = `${process.env.TMPDIR || "/tmp"}/realbud-pair-${process.pid}-${Date.now()}`; process.env.REALBUD_DATA_DIR = dir; return dir; });
const { createPairingCode, matchesPairingCode, clearPairingCode } = await import("./channel-pairing.ts");
beforeEach(() => rmSync(dir, { recursive: true, force: true }));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
describe("pairing from the local Mac", () => {
  it("does not accept first contact, malformed or absent codes", () => {
    expect(matchesPairingCode("telegram", "hello", 100)).toBe(false);
    expect(matchesPairingCode("telegram", "/pair 1234", 100)).toBe(false);
    expect(matchesPairingCode("telegram", "/pair 0123456789ABCDEF", 100)).toBe(false);
  });
  it("scopes codes to a platform, rotates them and expires them after ten minutes", () => {
    const a = createPairingCode("telegram", 100);
    expect(matchesPairingCode("telegram", a.command, 100)).toBe(true);
    expect(matchesPairingCode("discord", a.command, 100)).toBe(false);
    expect(matchesPairingCode("telegram", a.command, a.expiresAt)).toBe(false);
    const b = createPairingCode("telegram", 101);
    expect(matchesPairingCode("telegram", a.command, 101)).toBe(false);
    expect(matchesPairingCode("telegram", b.command.toLowerCase(), 101)).toBe(true);
    clearPairingCode("telegram");
    expect(matchesPairingCode("telegram", b.command, 102)).toBe(false);
  });
  it("keeps only a private digest on disk and rejects corrupt state", async () => {
    const a = createPairingCode("slack", 100); const file = join(dir, "pairing-slack.json");
    expect(readFileSync(file, "utf8")).not.toContain(a.command.split(" ")[1]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const { writeFileSync } = await import("node:fs"); writeFileSync(file, "broken");
    expect(matchesPairingCode("slack", a.command, 100)).toBe(false);
  });
});
