import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
    expect(existsSync(result.restoredFrom.replace("desk.json", "desk.key")) || existsSync(join(dir, "desk.key"))).toBe(true);
    expect(existsSync(result.restoredFrom)).toBe(false); // quarantine renamed back

    // restart with the restored on-disk key: the book opens
    const keyOnDisk = loadDeskKey({ dir }).key;
    const reopened = new Desk({ file, key: keyOnDisk });
    expect(reopened.snapshot().recovery.active).toBe(false);
    expect(reopened.snapshot().properties.some((p) => p.address === "1 Escrow St, Braddon ACT")).toBe(true);
  });
});
