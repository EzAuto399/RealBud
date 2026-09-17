import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as atomic from "./atomic.ts";
import { ConnectedAppOperationStore } from "./connected-app-operations.ts";

const dirs: string[] = [];
const tempFile = () => {
  const dir = mkdtempSync(join(tmpdir(), "realbud-app-operations-")); dirs.push(dir);
  return join(dir, "operations.json");
};
const input = { threadId: "thread-1", toolName: "COMPOSIO_MULTI_EXECUTE_TOOL", toolSlugs: ["GMAIL_FETCH_EMAILS"] };
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("connected-app durable operation receipts", () => {
  it("stores only identifiers and fixed status text, atomically with private permissions", () => {
    const file = tempFile(); let now = 10;
    const store = new ConnectedAppOperationStore({ file, now: () => now });
    const started = store.start({ ...input, arguments: { email: "private@example.test", key: "ck_private" } } as typeof input);
    expect(started.status).toBe("started");
    now = 20;
    const finished = store.finish(started.id, "succeeded");
    expect(finished.finishedAt).toBe(20);
    expect(new ConnectedAppOperationStore({ file }).list("thread-1")).toEqual([finished]);
    expect(store.list("other")).toEqual([]);
    expect(readFileSync(file, "utf8")).not.toMatch(/private@example|ck_private|arguments/);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    finished.toolSlugs.push("MUTATED");
    expect(store.list()[0].toolSlugs).toEqual(input.toolSlugs);
  });

  it("turns unfinished dispatches into unknown on restart without replay", () => {
    const file = tempFile();
    const store = new ConnectedAppOperationStore({ file, now: () => 10 });
    const started = store.start(input);
    const reopened = new ConnectedAppOperationStore({ file, now: () => 20 });
    expect(reopened.list()).toEqual([expect.objectContaining({ id: started.id, status: "unknown", finishedAt: 20 })]);
    expect(reopened.list()[0].detail).toContain("has not replayed");
    expect(new ConnectedAppOperationStore({ file }).list()[0].status).toBe("unknown");
  });

  it.each(["broken json", '{"version":2,"operations":[]}', '{"version":1,"operations":[null]}'])
    ("holds corrupt history without overwriting it", saved => {
      const file = tempFile(); writeFileSync(file, saved);
      const store = new ConnectedAppOperationStore({ file });
      expect(() => store.list()).toThrow(/history needs recovery/);
      expect(() => store.start(input)).toThrow(expect.objectContaining({ status: 503 }));
      expect(readFileSync(file, "utf8")).toBe(saved);
    });

  it("rejects malformed identifiers before creating any receipt", () => {
    const store = new ConnectedAppOperationStore({ file: tempFile() });
    expect(() => store.start({ ...input, toolName: "private@example.test" })).toThrow(/Invalid/);
    expect(() => store.start({ ...input, toolSlugs: ["read;write"] })).toThrow(/Invalid/);
    expect(store.list()).toEqual([]);
  });

  it("fails closed on ENOSPC before dispatch and preserves the previous disk state", () => {
    const file = tempFile(); const store = new ConnectedAppOperationStore({ file });
    store.deny(input); const before = readFileSync(file, "utf8");
    vi.spyOn(atomic, "writeFileAtomic").mockImplementation(() => { throw Object.assign(new Error("private disk path"), { code: "ENOSPC" }); });
    expect(() => store.start(input)).toThrow(expect.objectContaining({ status: 503 }));
    expect(() => store.list()).toThrow(/history needs recovery/);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("holds failed settlement and leaves a restart-recoverable started receipt", () => {
    const file = tempFile(); const store = new ConnectedAppOperationStore({ file });
    const started = store.start(input);
    const write = vi.spyOn(atomic, "writeFileAtomic").mockImplementation(() => { throw new Error("save failed"); });
    expect(() => store.finish(started.id, "succeeded")).toThrow(/history needs recovery/);
    expect(() => store.start(input)).toThrow(/history needs recovery/);
    write.mockRestore();
    expect(new ConnectedAppOperationStore({ file }).list()[0]).toMatchObject({ id: started.id, status: "unknown" });
  });

  it("does not acknowledge a write when rename succeeded but durable confirmation failed", () => {
    const file = tempFile(); const store = new ConnectedAppOperationStore({ file });
    vi.spyOn(atomic, "writeFileAtomic").mockImplementation((path, body) => { writeFileSync(path, body); throw new Error("fsync failed"); });
    expect(() => store.start(input)).toThrow(/history needs recovery/);
    vi.restoreAllMocks();
    expect(new ConnectedAppOperationStore({ file }).list()[0].status).toBe("unknown");
  });

  it("holds recovery if its startup transition cannot be saved", () => {
    const file = tempFile(); new ConnectedAppOperationStore({ file }).start(input);
    const before = readFileSync(file, "utf8");
    vi.spyOn(atomic, "writeFileAtomic").mockImplementation(() => { throw new Error("save failed"); });
    const reopened = new ConnectedAppOperationStore({ file });
    expect(() => reopened.list()).toThrow(/history needs recovery/);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("serializes concurrent callers and never regresses a final receipt", async () => {
    const store = new ConnectedAppOperationStore({ file: tempFile() });
    const rows = await Promise.all(Array.from({ length: 10 }, () => Promise.resolve().then(() => store.start(input))));
    expect(new Set(rows.map(row => row.id)).size).toBe(10);
    store.finish(rows[0].id, "failed", true);
    expect(store.finish(rows[0].id, "succeeded")).toMatchObject({ status: "failed", detail: expect.stringContaining("Some app operations failed") });
    expect(store.list()).toHaveLength(10);
  });

  it("bounds history while preserving all unresolved outcomes", () => {
    const file = tempFile(); const first = new ConnectedAppOperationStore({ file }).start(input);
    const rows = Array.from({ length: 1000 }, (_, index) => ({ ...first, id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}` }));
    writeFileSync(file, JSON.stringify({ version: 1, operations: rows }));
    const store = new ConnectedAppOperationStore({ file });
    expect(store.list()).toHaveLength(1000);
    expect(() => store.start(input)).toThrow(/full of unresolved/);
    expect(store.list().every(row => row.status === "unknown")).toBe(true);
  });
});
