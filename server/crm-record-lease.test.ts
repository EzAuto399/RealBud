import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCrmWriteJournal, crmRecordKey, InProcessCrmRecordLeases, type CrmWriteEntry } from "./crm-record-lease.ts";

const record = (recordId: string) => ({ workspace: "membership:fictional", object: "opportunity", recordId });

describe("CRM record leases", () => {
  it("admits one holder per record; a second waits for release, a third times out", async () => {
    const leases = new InProcessCrmRecordLeases();
    const first = await leases.acquire(record("r1"), { holder: "a", waitMs: 1000 });
    expect(first).not.toBeNull();
    const second = leases.acquire(record("r1"), { holder: "b", waitMs: 1000 });
    expect(await leases.acquire(record("r1"), { holder: "c", waitMs: 20 })).toBeNull();
    await first!.release();
    const admitted = await second;
    expect(admitted).toMatchObject({ holder: "b" });
    expect(admitted!.fence).toBeGreaterThan(first!.fence);
    await first!.release(); // idempotent: cannot free the next holder's lease
    expect(await leases.acquire(record("r1"), { holder: "d", waitMs: 10 })).toBeNull();
    await admitted!.release();
    expect(leases.size).toBe(0);
  });

  it("never lets a newcomer slip ahead of a woken waiter", async () => {
    const leases = new InProcessCrmRecordLeases();
    const first = await leases.acquire(record("r1"), { holder: "a", waitMs: 0 });
    const waiter = leases.acquire(record("r1"), { holder: "b", waitMs: 1000 });
    await first!.release();
    const newcomer = await leases.acquire(record("r1"), { holder: "c", waitMs: 0 });
    expect(newcomer).toBeNull();
    expect((await waiter)!.holder).toBe("b");
  });

  it("runs different records in parallel and honours abort", async () => {
    const leases = new InProcessCrmRecordLeases();
    const one = await leases.acquire(record("r1"), { holder: "a", waitMs: 0 });
    const two = await leases.acquire(record("r2"), { holder: "b", waitMs: 0 });
    expect(one && two).toBeTruthy();
    const abort = new AbortController();
    const pending = leases.acquire(record("r1"), { holder: "c", waitMs: 5000, signal: abort.signal });
    abort.abort();
    expect(await pending).toBeNull();
    expect(crmRecordKey(record("r1"))).toMatch(/^[a-f0-9]{64}$/);
    expect(() => crmRecordKey({ workspace: "", object: "x", recordId: "y" })).toThrow();
  });
});

describe("CRM write journal", () => {
  const entry = (correlationId: string, approvedAt: number): CrmWriteEntry => ({ correlationId, tool: "crm_add_note", workspace: "0a0a0a0a-0000-4000-8000-00000000a11c",
    generation: 1, record: { view: "companies", recordId: "22222222-0000-4000-8000-000000000001" }, approvedAt, steps: [] });

  it("persists keys and returned ids privately, survives a restart and prunes after 48 hours", async () => {
    const directory = mkdtempSync(join(tmpdir(), "realbud-crm-journal-"));
    let now = 1_800_000_000_000;
    const journal = createCrmWriteJournal(directory, () => now);
    await journal.begin(entry("crm-old", now));
    now += 49 * 3_600_000;
    await journal.begin(entry("crm-one", now));
    await journal.step("crm-one", { kind: "create", idempotencyKey: "realbud:crm-one:note", status: "pending" });
    await journal.step("crm-one", { kind: "create", idempotencyKey: "realbud:crm-one:note", status: "succeeded", resultId: "44444444-0000-4000-8000-000000000001" });
    const file = join(directory, "hermios-crm", "write-receipts.json");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o077).toBe(0);
    const restarted = createCrmWriteJournal(directory, () => now);
    expect(await restarted.list()).toEqual([{ ...entry("crm-one", now), steps: [{ kind: "create", idempotencyKey: "realbud:crm-one:note", status: "succeeded", resultId: "44444444-0000-4000-8000-000000000001" }] }]);
    await expect(restarted.step("crm-missing", { kind: "link", idempotencyKey: "k", status: "pending" })).rejects.toThrow(/no saved receipt/);
    expect(readFileSync(file, "utf8")).not.toMatch(/token|body/i);
  });

  it("fails closed on a damaged file and keeps it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "realbud-crm-journal-"));
    const journal = createCrmWriteJournal(directory);
    await journal.begin(entry("crm-one", Date.now()));
    const file = join(directory, "hermios-crm", "write-receipts.json");
    writeFileSync(file, JSON.stringify({ version: 1, entries: [{ correlationId: "bad id" }] }), { mode: 0o600 });
    await expect(journal.begin(entry("crm-two", Date.now()))).rejects.toThrow(/need recovery/);
    expect(readFileSync(file, "utf8")).toContain("bad id");
  });
});
