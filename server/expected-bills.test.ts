import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const readFault = vi.hoisted(() => ({ path: "", code: "" }));
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, readFileSync: (...args: unknown[]) => {
    if (readFault.path && String(args[0]) === readFault.path) {
      throw Object.assign(new Error("private-path-and-file-content-must-not-leak"), { code: readFault.code });
    }
    return Reflect.apply(actual.readFileSync, actual, args);
  } };
});

import { groupExpectedBills, listExpectedBills, upsertExpectedBill } from "./expected-bills.ts";

const dirs: string[] = [];
afterEach(() => {
  readFault.path = ""; readFault.code = "";
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "realbud-bills-recovery-"));
  dirs.push(dir);
  return { dir, path: join(dir, "expected-bills.json") };
}

const savedBill = {
  id: "existing-bill", propertyId: "prop-1", kind: "water", status: "received",
  windowStartAt: null, windowEndAt: 1_789_420_000_000, amountCents: 12_345,
  note: "Keep this office correction", sourceRef: "synthetic:invoice-1",
  createdAt: 1_789_410_000_000, updatedAt: 1_789_415_000_000,
};
const stored = (bills: unknown[]) => JSON.stringify({ version: 1, bills });
const newBill = { propertyId: "prop-2", kind: "levy", status: "expected" as const };
const recovery = { status: 503, code: "expected_bills_recovery_required" };

describe("expected-bills", () => {
  it("persists bill rows and groups exception states for Desk", () => {
    const dir = mkdtempSync(join(tmpdir(), "realbud-bills-"));
    dirs.push(dir);
    const missing = upsertExpectedBill(
      { propertyId: "prop-1", kind: "council", status: "missing", windowEndAt: Date.now() - 86_400_000 },
      dir,
    );
    upsertExpectedBill(
      { propertyId: "prop-1", kind: "water", status: "company-advance", note: "Office paid; recover from owner" },
      dir,
    );
    upsertExpectedBill({ propertyId: "prop-2", kind: "levy", status: "paid" }, dir);

    const listed = listExpectedBills(dir);
    expect(listed).toHaveLength(3);
    const groups = groupExpectedBills(listed);
    expect(groups["needs-you"].map((b) => b.status).sort()).toEqual(["company-advance", "missing"]);
    expect(groups.settled).toHaveLength(1);

    const again = upsertExpectedBill({ id: missing.id, propertyId: "prop-1", kind: "council", status: "received" }, dir);
    expect(again.id).toBe(missing.id);
    expect(again.status).toBe("received");
  });

  it("treats an absent file as first use and creates a reopenable v1 register", () => {
    const { dir, path } = fixture();
    expect(listExpectedBills(dir)).toEqual([]);
    expect(existsSync(path)).toBe(false);
    const bill = upsertExpectedBill(newBill, dir);
    expect(listExpectedBills(dir)).toEqual([bill]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 1, bills: [bill] });
  });

  it.each([
    ["truncated JSON", '{"version":1,"bills":[{"id":"existing-bill"'],
    ["empty file", ""],
    ["null root", "null"],
    ["unknown schema", '{"version":2,"bills":[]}'],
    ["missing bills", '{"version":1}'],
    ["non-array bills", '{"version":1,"bills":{}}'],
    ["null record", stored([savedBill, null])],
    ["incomplete record", stored([savedBill, { id: "other-bill" }])],
    ["missing property", stored([{ ...savedBill, propertyId: "" }])],
    ["unknown status", stored([{ ...savedBill, status: "complete-maybe" }])],
    ["invalid timestamp", stored([{ ...savedBill, updatedAt: "yesterday" }])],
    ["invalid amount", stored([{ ...savedBill, amountCents: "12345" }])],
    ["invalid source", stored([{ ...savedBill, sourceRef: { private: "content" } }])],
    ["duplicate IDs", stored([savedBill, { ...savedBill, note: "Another record with same ID" }])],
  ])("holds reads and subsequent mutations without changing bytes: %s", (_label, bytes) => {
    const { dir, path } = fixture();
    writeFileSync(path, bytes);
    expect(() => listExpectedBills(dir)).toThrowError(expect.objectContaining(recovery));
    expect(() => upsertExpectedBill(newBill, dir)).toThrowError(expect.objectContaining(recovery));
    expect(() => upsertExpectedBill({ ...newBill, id: savedBill.id }, dir)).toThrowError(expect.objectContaining(recovery));
    expect(readFileSync(path, "utf8")).toBe(bytes);
  });

  it.each(["EACCES", "EIO"])("preserves unreadable data and reports a safe recovery error (%s)", code => {
    const { dir, path } = fixture();
    const bytes = stored([savedBill]);
    writeFileSync(path, bytes);
    readFault.path = path; readFault.code = code;
    let error: unknown;
    try { listExpectedBills(dir); } catch (cause) { error = cause; }
    expect(error).toMatchObject(recovery);
    expect((error as Error).message).toMatch(/Contact support/);
    expect((error as Error).message).not.toMatch(/private-path|file-content/);
    expect(() => upsertExpectedBill(newBill, dir)).toThrowError(expect.objectContaining(recovery));
    readFault.path = "";
    expect(readFileSync(path, "utf8")).toBe(bytes);
    expect(listExpectedBills(dir)).toEqual([savedBill]);
  });

  it("holds a directory in place of the register without replacing its contents", () => {
    const { dir, path } = fixture();
    mkdirSync(path);
    const marker = join(path, "retain-me");
    writeFileSync(marker, "synthetic retained content");
    expect(() => listExpectedBills(dir)).toThrowError(expect.objectContaining(recovery));
    expect(() => upsertExpectedBill(newBill, dir)).toThrowError(expect.objectContaining(recovery));
    expect(readFileSync(marker, "utf8")).toBe("synthetic retained content");
  });

  it("reads valid existing data without rewriting it and preserves unrelated metadata on update", () => {
    const { dir, path } = fixture();
    const existing = { version: 1, officeMetadata: { retained: true }, bills: [savedBill] };
    const bytes = JSON.stringify(existing, null, 2);
    writeFileSync(path, bytes);
    expect(listExpectedBills(dir)).toEqual([savedBill]);
    expect(readFileSync(path, "utf8")).toBe(bytes);
    upsertExpectedBill(newBill, dir);
    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(after.officeMetadata).toEqual(existing.officeMetadata);
    expect(after.bills).toContainEqual(savedBill);
    expect(listExpectedBills(dir)).toHaveLength(2);
  });

  it("accepts a repaired valid register without retaining a false recovery state", () => {
    const { dir, path } = fixture();
    writeFileSync(path, "corrupt");
    expect(() => listExpectedBills(dir)).toThrowError(expect.objectContaining(recovery));
    writeFileSync(path, stored([savedBill]));
    upsertExpectedBill(newBill, dir);
    expect(listExpectedBills(dir)).toHaveLength(2);
  });

  it.each([
    { windowStartAt: "tomorrow" }, { windowEndAt: Number.POSITIVE_INFINITY },
    { amountCents: Number.NaN }, { sourceRef: { private: "content" } },
  ])("refuses an input that could poison a valid register: %j", invalid => {
    const { dir, path } = fixture();
    const bytes = stored([savedBill]);
    writeFileSync(path, bytes);
    const input = { ...newBill, ...invalid } as Parameters<typeof upsertExpectedBill>[0];
    expect(() => upsertExpectedBill(input, dir)).toThrowError(expect.objectContaining({ status: 400 }));
    expect(readFileSync(path, "utf8")).toBe(bytes);
  });
});
