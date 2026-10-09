import { randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, linkSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
const workspaceId = '00000000-0000-4000-8000-000000000001';
const mailInput = (store: ConnectedAppOperationStore) => ({ threadId: 'thread-mail', toolName: 'GMAIL_SEND_EMAIL', toolSlugs: [], accountDigest: 'a'.repeat(64), realmDigest: 'f'.repeat(64),
  bindingDigest: 'b'.repeat(64), effectDigest: 'c'.repeat(64), reviewDigest: 'd'.repeat(64), workspaceDigest: store.workspaceDigest });
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("connected-app durable operation receipts", () => {
  it('holds the same effect across restart, RPC/thread changes and new binding generations', () => {
    const file = tempFile(), first = new ConnectedAppOperationStore({ file, workspaceId });
    const row = first.start(mailInput(first)); first.finish(row.id, 'unknown');
    const restarted = new ConnectedAppOperationStore({ file, workspaceId });
    expect(() => restarted.start({ ...mailInput(restarted), threadId: 'new-thread', bindingDigest: 'e'.repeat(64) })).toThrow(/unresolved outcome/);
    expect(restarted.list()).toHaveLength(1);
    const moved = tempFile(); copyFileSync(file, moved); chmodSync(moved, 0o600);
    const restored = new ConnectedAppOperationStore({ file: moved, workspaceId });
    expect(restored.workspaceDigest).toBe(first.workspaceDigest);
    expect(() => restored.start(mailInput(restored))).toThrow(/unresolved outcome/);
    const foreign = new ConnectedAppOperationStore({ file: moved, workspaceId: '00000000-0000-4000-8000-000000000002' });
    expect(() => foreign.start({ ...mailInput(foreign), effectDigest: 'f'.repeat(64) })).toThrow(/another private workspace/);
  });
  it('holds legacy identified rows missing realm and rejects a new realm within retained workspace history', () => {
    const file = tempFile(), first = new ConnectedAppOperationStore({ file, workspaceId });
    const row = first.start(mailInput(first)); first.finish(row.id, 'unknown');
    expect(() => first.start({ ...mailInput(first), accountDigest: 'e'.repeat(64), realmDigest: 'e'.repeat(64), effectDigest: 'e'.repeat(64) })).toThrow(/company\/gateway realm/);
    const snapshot = JSON.parse(readFileSync(file, 'utf8')); delete snapshot.operations[0].realmDigest;
    writeFileSync(file, JSON.stringify(snapshot), { mode: 0o600 });
    const legacy = new ConnectedAppOperationStore({ file, workspaceId });
    expect(legacy.list()[0].status).toBe('unknown'); expect(() => legacy.start(mailInput(legacy))).toThrow(/unverified or different company/);
  });
  it('serializes two independently opened stores before starting a second identical effect', () => {
    const file = tempFile(), first = new ConnectedAppOperationStore({ file, workspaceId }), second = new ConnectedAppOperationStore({ file, workspaceId });
    first.start(mailInput(first));
    expect(() => second.start(mailInput(second))).toThrow(/unresolved outcome/);
    expect(second.list()).toHaveLength(1);
  });
  it('keeps unidentified legacy mail outcomes held rather than guessing their account or payload', () => {
    const file = tempFile(), old = new ConnectedAppOperationStore({ file });
    const legacy = old.start({ ...input, toolName: 'COMPOSIO_MULTI_EXECUTE_TOOL', toolSlugs: ['OUTLOOK_FORWARD_MESSAGE'] }); old.finish(legacy.id, 'unknown');
    const current = new ConnectedAppOperationStore({ file, workspaceId });
    expect(() => current.start(mailInput(current))).toThrow(/older mail operation/);
    expect(() => current.reconcile(legacy.id, 1, 'not-sent', { accountDigest: 'a'.repeat(64), realmDigest: 'f'.repeat(64), originalBindingDigest: 'b'.repeat(64), recoveryBindingDigest: 'b'.repeat(64), workspaceDigest: current.workspaceDigest })).toThrow(/original verified/);
  });
  it.each([false, true])('holds legacy failed mail, including partial batch=%s, without inventing not-sent evidence', partial => {
    const file = tempFile(), old = new ConnectedAppOperationStore({ file });
    const row = old.start({ ...input, toolName: partial ? 'COMPOSIO_MULTI_EXECUTE_TOOL' : 'GMAIL_SEND_EMAIL', toolSlugs: partial ? ['GMAIL_SEND_EMAIL'] : [] });
    old.finish(row.id, 'failed', partial);
    const current = new ConnectedAppOperationStore({ file, workspaceId });
    expect(() => current.start(mailInput(current))).toThrow(/original-review identity/);
    expect(current.list()[0].status).toBe('failed'); expect(current.list()[0].reconciliation).toBeUndefined();
  });
  it('retains all 1000 identified successful effects and explains the fixed safety capacity truthfully', () => {
    const file = tempFile(), first = new ConnectedAppOperationStore({ file, workspaceId });
    const started = first.start(mailInput(first)); const base = first.finish(started.id, 'succeeded');
    const rows = Array.from({ length: 1000 }, (_, i) => ({ ...base, id: randomUUID(), effectDigest: i.toString(16).padStart(64, '0') }));
    writeFileSync(file, JSON.stringify({ version: 1, operations: rows }), { mode: 0o600 });
    const reopened = new ConnectedAppOperationStore({ file, workspaceId });
    expect(() => reopened.start({ ...mailInput(reopened), effectDigest: 'f'.repeat(64) })).toThrow(/service support/);
    expect(reopened.list()).toHaveLength(1000); expect(reopened.list().every(row => row.status === 'succeeded')).toBe(true);
  });
  it('records manual evidence separately, rejects stale/contrary decisions and requires explicit linked repeats', () => {
    const store = new ConnectedAppOperationStore({ file: tempFile(), workspaceId }), row = store.start(mailInput(store));
    store.finish(row.id, 'unknown');
    const binding = { accountDigest: row.accountDigest!, realmDigest: row.realmDigest!, originalBindingDigest: row.bindingDigest!, recoveryBindingDigest: 'e'.repeat(64), workspaceDigest: store.workspaceDigest };
    expect(() => store.reconcile(row.id, 0, 'sent', binding)).toThrow(/changed/);
    const confirmed = store.reconcile(row.id, 1, 'sent', binding);
    expect(confirmed.status).toBe('unknown'); expect(confirmed.bindingDigest).toBe(row.bindingDigest);
    expect(confirmed.reconciliation).toMatchObject({ source: 'manual-app-inspection', outcome: 'sent', recoveryBindingDigest: 'e'.repeat(64) });
    expect(store.reconcile(row.id, 1, 'sent', binding)).toEqual(confirmed);
    expect(() => store.reconcile(row.id, 1, 'not-sent', binding)).toThrow(/changed/);
    expect(() => store.start(mailInput(store))).toThrow(/intentional-repeat approval/);
    const repeat = store.start({ ...mailInput(store), bindingDigest: 'e'.repeat(64), repeatOf: row.id });
    expect(repeat.id).not.toBe(row.id); expect(repeat.repeatOf).toBe(row.id);
    expect(() => store.start({ ...mailInput(store), repeatOf: row.id })).toThrow(/unresolved outcome/);
  });
  it('permits a fresh approved attempt after a proven pre-dispatch rollback or confirmed not-sent', () => {
    const store = new ConnectedAppOperationStore({ file: tempFile(), workspaceId }), first = store.start(mailInput(store));
    store.cancelBeforeDispatch(first.id);
    const second = store.start(mailInput(store)); store.finish(second.id, 'unknown');
    store.reconcile(second.id, 1, 'not-sent', { accountDigest: second.accountDigest!, realmDigest: second.realmDigest!, originalBindingDigest: second.bindingDigest!, recoveryBindingDigest: second.bindingDigest!, workspaceDigest: store.workspaceDigest });
    expect(store.start(mailInput(store)).id).not.toBe(second.id);
  });
  it('rejects linked and too-open receipt files without changing or reading their targets', () => {
    const original = tempFile(), file = tempFile(); new ConnectedAppOperationStore({ file: original }).start(input);
    symlinkSync(original, file); expect(() => new ConnectedAppOperationStore({ file }).list()).toThrow(/history needs recovery/);
    rmSync(file); linkSync(original, file); expect(() => new ConnectedAppOperationStore({ file }).list()).toThrow(/history needs recovery/);
    rmSync(file); copyFileSync(original, file); chmodSync(file, 0o644);
    expect(() => new ConnectedAppOperationStore({ file }).list()).toThrow(/history needs recovery/); expect(statSync(file).mode & 0o777).toBe(0o644);
  });
  it('does not infer a failed effect from an old crash lock; unlock recovery retains unknown outcome', () => {
    const file = tempFile(), store = new ConnectedAppOperationStore({ file, workspaceId }); store.start(mailInput(store));
    writeFileSync(`${file}.lock`, '', { mode: 0o600 });
    expect(() => new ConnectedAppOperationStore({ file, workspaceId }).list()).toThrow(/history needs recovery/);
    rmSync(`${file}.lock`);
    const reopened = new ConnectedAppOperationStore({ file, workspaceId }); expect(reopened.list()[0].status).toBe('unknown');
    expect(() => reopened.start(mailInput(reopened))).toThrow(/unresolved outcome/);
  });
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

  it("keeps who answered a phone card, and refuses a multi-line approval", () => {
    const file = tempFile();
    const store = new ConnectedAppOperationStore({ file, now: () => 10 });
    const denied = store.deny({ ...input, approval: "Denied by Fictional Sam via Telegram · 2:16 pm" });
    expect(new ConnectedAppOperationStore({ file }).list()).toEqual([denied]);
    expect(denied.approval).toBe("Denied by Fictional Sam via Telegram · 2:16 pm");
    expect(() => store.start({ ...input, approval: "Allowed\nby someone" })).toThrow(/Invalid app operation/);
  });

  it("turns unfinished dispatches into unknown on restart without replay", () => {
    const file = tempFile();
    const store = new ConnectedAppOperationStore({ file, now: () => 10 });
    const started = store.start(input);
    const reopened = new ConnectedAppOperationStore({ file, now: () => 20 });
    // Explicit stores still recover eagerly, before any public method is used.
    expect(JSON.parse(readFileSync(file, "utf8")).operations[0]).toMatchObject({ id: started.id, status: "unknown", finishedAt: 20 });
    expect(reopened.list()).toEqual([expect.objectContaining({ id: started.id, status: "unknown", finishedAt: 20 })]);
    expect(reopened.list()[0].detail).toContain("has not replayed");
    expect(new ConnectedAppOperationStore({ file }).list()[0].status).toBe("unknown");
  });

  it.each(["broken json", '{"version":2,"operations":[]}', '{"version":1,"operations":[null]}'])
    ("holds corrupt history without overwriting it", saved => {
      const file = tempFile(); writeFileSync(file, saved, { mode: 0o600 });
      const store = new ConnectedAppOperationStore({ file });
      expect(() => store.list()).toThrow(/history needs recovery/);
      expect(() => store.start(input)).toThrow(expect.objectContaining({ status: 503 }));
      expect(readFileSync(file, "utf8")).toBe(saved);
    });

  it("keeps an explicit store's initialization failure held after a fixture is repaired", () => {
    const file = tempFile(); writeFileSync(file, 'broken json', { mode: 0o600 });
    const store = new ConnectedAppOperationStore({ file });
    writeFileSync(file, JSON.stringify({ version: 1, operations: [] }), { mode: 0o600 });
    expect(() => store.list()).toThrow(/history needs recovery/);
    expect(() => store.deny(input)).toThrow(/history needs recovery/);
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
    vi.spyOn(atomic, "writeFileAtomic").mockImplementation((path, body) => { writeFileSync(path, body, { mode: 0o600 }); throw new Error("fsync failed"); });
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
    expect(() => store.start(input)).toThrow(/history reached its safety limit/);
    expect(store.list().every(row => row.status === "unknown")).toBe(true);
  });
});
