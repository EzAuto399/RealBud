import { describe, expect, it, vi } from "vitest";
import { createOfficeSourceStore } from "./office-source-store";
import { officeSourceState, readyOfficeApps, type ConnectedAppsStatus } from "@shared/office-sources";

const snapshot = (patch: Partial<ConnectedAppsStatus> = {}): ConnectedAppsStatus => ({ configured: true, checkedAt: new Date().toISOString(), services: {
  gmail: { connected: true, status: "ACTIVE", accountSelectionRequired: false, accounts: [{ id: "fictional-office", status: "ACTIVE" }] },
  instagram: { connected: true, status: "ACTIVE", accountSelectionRequired: false, accounts: [{ id: "fictional-social", status: "ACTIVE" }] },
}, tools: { available: true, names: ["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_MULTI_EXECUTE_TOOL"] }, ...patch });

describe("office source continuity", () => {
  it("shares one read across surfaces and retains non-mail apps", async () => {
    const request = vi.fn(async () => snapshot());
    const store = createOfficeSourceStore(request);
    const listener = vi.fn(); store.subscribe(listener);
    const [add, admin] = await Promise.all([store.refresh(), store.refresh()]);
    expect(request).toHaveBeenCalledOnce(); expect(add).toEqual(admin);
    expect(store.getSnapshot().snapshot?.services.instagram.connected).toBe(true);
    expect(listener).toHaveBeenCalled();
  });
  it("keeps single-character app IDs in the shared inventory", async () => {
    const store = createOfficeSourceStore(async () => snapshot({ services: { x: snapshot().services.instagram } }));
    await store.refresh();
    expect(readyOfficeApps(store.getSnapshot().snapshot)).toEqual(["x"]);
  });
  it("a late successful check cannot bring back a removed source", async () => {
    let finish!: (body: unknown) => void;
    const store = createOfficeSourceStore(() => new Promise(resolve => { finish = resolve; }));
    const old = store.refresh(); await Promise.resolve(); store.invalidate();
    store.accept(snapshot({ excludedApps: ["gmail"] }));
    finish(snapshot()); await old;
    expect(readyOfficeApps(store.getSnapshot().snapshot)).toEqual(["instagram"]);
  });
  it("clears usable access on a failed or malformed refresh, then recovers", async () => {
    const request = vi.fn().mockResolvedValueOnce(snapshot()).mockRejectedValueOnce(new Error("private-provider-payload"))
      .mockResolvedValueOnce({ configured: true }).mockResolvedValueOnce(snapshot());
    const store = createOfficeSourceStore(request);
    await store.refresh(); await store.refresh();
    expect(readyOfficeApps(store.getSnapshot().snapshot)).toEqual([]);
    expect(store.getSnapshot().error).not.toContain("private-provider-payload");
    await store.refresh(); expect(store.getSnapshot().snapshot).toBeNull();
    await store.refresh(); expect(readyOfficeApps(store.getSnapshot().snapshot)).toContain("gmail");
  });
  it.each(["success", "failure"])("a late background %s cannot replace a confirmed account choice", async outcome => {
    let finish!: (body: unknown) => void;
    let fail!: (error: Error) => void;
    let signal: AbortSignal | undefined;
    const store = createOfficeSourceStore((_path, init) => {
      signal = init?.signal ?? undefined;
      return new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    });
    const checking = store.refresh();
    await Promise.resolve();
    const confirmed = snapshot();
    confirmed.services.gmail.accounts.push({ id: "second-office", status: "ACTIVE" });
    confirmed.services.gmail.selectedAccountId = "second-office";
    store.accept(confirmed);
    if (outcome === "success") finish(snapshot());
    else fail(new Error("private-provider-payload"));
    await checking;
    expect(store.getSnapshot().snapshot?.services.gmail.selectedAccountId).toBe("second-office");
    expect(store.getSnapshot().error).toBe("");
    expect(store.getSnapshot().loading).toBe(false);
    expect(signal?.aborted).toBe(true);
  });
  it("can check again after an immediate transport failure", async () => {
    const request = vi.fn().mockImplementationOnce(() => { throw new Error("offline"); }).mockResolvedValueOnce(snapshot());
    const store = createOfficeSourceStore(request);
    await store.refresh();
    expect(store.getSnapshot().error).toContain("Couldn’t check");
    await store.refresh();
    expect(request).toHaveBeenCalledTimes(2);
    expect(readyOfficeApps(store.getSnapshot().snapshot)).toContain("gmail");
    expect(store.getSnapshot().loading).toBe(false);
  });
  it("settles sign-in when the live event arrives before its matching HTTP check", async () => {
    let finish!: (body: unknown) => void;
    const store = createOfficeSourceStore(() => new Promise(resolve => { finish = resolve; }));
    store.setPending("gmail");
    const signingIn = snapshot();
    signingIn.services.gmail = { connected: false, status: "INITIATED", accountSelectionRequired: false, accounts: [] };
    store.accept(signingIn);
    expect(store.getSnapshot().pendingService).toBe("gmail");
    const checking = store.refresh(); await Promise.resolve();
    store.accept(snapshot());
    expect(store.getSnapshot().pendingService).toBeNull();
    expect(store.getSnapshot().loading).toBe(false);
    finish(snapshot()); await checking;
    expect(store.getSnapshot().pendingService).toBeNull();
    expect(readyOfficeApps(store.getSnapshot().snapshot)).toContain("gmail");
  });
  it("an older failed request cannot settle or clear a newer in-flight check", async () => {
    let failOld!: (error: Error) => void;
    let finishNew!: (body: unknown) => void;
    const request = vi.fn()
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { failOld = reject; }))
      .mockImplementationOnce(() => new Promise(resolve => { finishNew = resolve; }));
    const store = createOfficeSourceStore(request);
    const old = store.refresh(); await Promise.resolve();
    store.invalidate();
    const current = store.refresh(); await Promise.resolve();
    failOld(new Error("offline")); await old;
    expect(store.getSnapshot().loading).toBe(true);
    expect(store.getSnapshot().error).toBe("");
    expect(store.refresh()).toBe(current);
    finishNew(snapshot({ excludedApps: ["gmail"] })); await current;
    expect(readyOfficeApps(store.getSnapshot().snapshot)).toEqual(["instagram"]);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("clears old usable status when a saved response is incomplete and recovers with a check", async () => {
    const store = createOfficeSourceStore(async () => snapshot());
    store.accept(snapshot());
    expect(() => store.accept({ configured: true })).toThrow(/incomplete/);
    expect(readyOfficeApps(store.getSnapshot().snapshot)).toEqual([]);
    expect(store.getSnapshot().error).not.toBe("");
    await store.refresh();
    expect(readyOfficeApps(store.getSnapshot().snapshot)).toContain("gmail");
  });
  it("distinguishes sign-in, account choice, stale observations, tools and source removal", () => {
    expect(officeSourceState(snapshot({ tools: { available: false, names: [] } }), "gmail")).toBe("degraded");
    expect(officeSourceState(snapshot({ checkedAt: new Date(Date.now() - 300_001).toISOString() }), "gmail")).toBe("unchecked");
    const access = snapshot(); access.services.gmail.status = "INITIATED";
    expect(officeSourceState(access, "gmail")).toBe("signing-in");
    access.services.gmail.status = "ACTIVE"; access.services.gmail.accounts.push({ id: "other", status: "ACTIVE" });
    expect(officeSourceState(access, "gmail")).toBe("choose-account");
    access.services.gmail.selectedAccountId = "other";
    expect(officeSourceState(access, "gmail")).toBe("ready");
    access.excludedApps = ["gmail"];
    expect(officeSourceState(access, "gmail")).toBe("excluded");
  });
});
