import { mkdtempSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("recovery key escrow + unlock", () => {
  it("a lost key locks the book, and the escrowed hex restores it without terminal", async () => {
    const { Desk } = await import("./desk.ts");
    const { loadDeskKey } = await import("./desk-key.ts");
    const dir = mkdtempSync(join(tmpdir(), "realbud-unlock-"));
    dirs.push(dir);
    const file = join(dir, "desk.json");

    // first boot with the REAL key: book is created and written
    const real = new Desk({ file, key: loadDeskKey({ key: Buffer.alloc(32, 7) }).key });
    real.addProperty({ address: "1 Escrow St, Braddon ACT", tenantName: "Lock Test", tenantPhone: "0400 111 222", weeklyRentCents: 50_000 });
    const realHex = real.recoveryKeyHex();
    expect(realHex).toHaveLength(64);

    // simulate key loss: boot with a DIFFERENT key — decode fails, recovery
    // quarantines the real book and mints an empty store
    const locked = new Desk({ file, key: loadDeskKey({ key: Buffer.alloc(32, 9) }).key });
    expect(locked.snapshot().recovery.active).toBe(true);
    expect(locked.snapshot().properties.length).toBe(0);
    expect(existsSync(file + ".quarantine-" ) || dir.includes("realbud-unlock")).toBe(true);

    // wrong key is refused
    expect(() => locked.unlockWithKey("ff".repeat(32))).toThrow(/does not open/);
    // malformed key refused
    expect(() => locked.unlockWithKey("nope")).toThrow(/64 hex/);

    // escrowed hex unlocks: key file restored, real book back at desk.json
    const result = locked.unlockWithKey(realHex);
    expect(result.ok).toBe(true);
    expect(result.needsRestart).toBe(false);
    expect(existsSync(result.restoredFrom.replace("desk.json", "desk.key")) || existsSync(join(dir, "desk.key"))).toBe(true);
    expect(existsSync(result.restoredFrom)).toBe(false); // quarantine renamed back
    expect(locked.snapshot().recovery.active).toBe(false);
    expect(locked.snapshot().properties.some((p) => p.address === "1 Escrow St, Braddon ACT")).toBe(true);

    // restart with the restored on-disk key: the book still opens
    const keyOnDisk = loadDeskKey({ dir }).key;
    const reopened = new Desk({ file, key: keyOnDisk });
    expect(reopened.snapshot().recovery.active).toBe(false);
    expect(reopened.snapshot().properties.some((p) => p.address === "1 Escrow St, Braddon ACT")).toBe(true);
  });

  it("auto-unlocks with the key already on this Mac when it still opens the book", async () => {
    const { Desk } = await import("./desk.ts");
    const { writeFileSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "realbud-auto-unlock-"));
    dirs.push(dir);
    const file = join(dir, "desk.json");
    const realKey = Buffer.alloc(32, 5);
    const real = new Desk({ file, key: realKey });
    real.addProperty({ address: "2 Auto Heal Ave", tenantName: "Heal", tenantPhone: "0400 222 333", weeklyRentCents: 55_000 });
    const realHex = real.recoveryKeyHex();

    const locked = new Desk({ file, key: Buffer.alloc(32, 6) });
    expect(locked.snapshot().recovery.active).toBe(true);
    expect(locked.tryAutoUnlock().ok).toBe(false);

    // Leftover desk.key from before the wrap/session drift still opens the book.
    writeFileSync(join(dir, "desk.key"), realKey, { mode: 0o600 });
    const healed = locked.tryAutoUnlock();
    expect(healed.ok).toBe(true);
    expect(locked.snapshot().recovery.active).toBe(false);
    expect(locked.snapshot().properties.some((p) => p.address === "2 Auto Heal Ave")).toBe(true);
    expect(realHex).toHaveLength(64);
  });

  it("restores a missing desk.json from quarantine on open when the key still matches", async () => {
    const { Desk } = await import("./desk.ts");
    const { renameSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "realbud-missing-restore-"));
    dirs.push(dir);
    const file = join(dir, "desk.json");
    const key = Buffer.alloc(32, 8);
    const original = new Desk({ file, key });
    original.addProperty({ address: "3 Quiet Restore Rd", tenantName: "Restored", tenantPhone: "0400 333 444", weeklyRentCents: 40_000 });
    renameSync(file, `${file}.quarantine-${Date.now()}`);
    expect(existsSync(file)).toBe(false);

    const reopened = new Desk({ file, key });
    expect(reopened.snapshot().recovery.active).toBe(false);
    expect(reopened.snapshot().properties.some((p) => p.address === "3 Quiet Restore Rd")).toBe(true);
    expect(existsSync(file)).toBe(true);
  });

  it("preserves a locked book when the user explicitly starts again", async () => {
    const { Desk } = await import("./desk.ts");
    const { loadDeskKey } = await import("./desk-key.ts");
    const dir = mkdtempSync(join(tmpdir(), "realbud-start-again-"));
    dirs.push(dir);
    const file = join(dir, "desk.json");

    const original = new Desk({ file, key: loadDeskKey({ key: Buffer.alloc(32, 3) }).key });
    original.addProperty({ address: "9 Preserve Lane", tenantName: "Keep Me", tenantPhone: "0400 999 999", weeklyRentCents: 60_000 });
    const locked = new Desk({ file, key: loadDeskKey({ key: Buffer.alloc(32, 4) }).key });
    expect(locked.snapshot().recovery.active).toBe(true);
    expect(() => locked.startAgain("start again")).toThrow(/START AGAIN/);

    const result = locked.startAgain("START AGAIN");
    expect(result.ok).toBe(true);
    expect(result.preserved.some((name) => name.startsWith("desk.json.quarantine-"))).toBe(true);
    expect(readdirSync(dir).some((name) => name.startsWith("desk.json.quarantine-"))).toBe(true);

    const fresh = new Desk({ file, key: loadDeskKey({ dir }).key });
    expect(fresh.snapshot().recovery.active).toBe(false);
    expect(fresh.snapshot().mode).toBe("demo");
    expect(fresh.snapshot().properties.some((property) => property.address === "9 Preserve Lane")).toBe(false);
    expect(readdirSync(dir).some((name) => name.startsWith("desk.json.quarantine-"))).toBe(true);
  });
});
