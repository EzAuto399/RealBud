import { describe, expect, it, vi } from "vitest";
import { ConnectedAppAccessCache, connectedAppConfigPatch } from "./connected-app-access.ts";
import { platformUserId } from "./composio.ts";

const cfg = { composio: { key: "ak_fictional" } };
const evidence = () => ({ checkedAt: new Date(1000).toISOString(), services: {}, tools: { available: true, names: ["COMPOSIO_MULTI_EXECUTE_TOOL"] } });

describe("connected app observations", () => {
  it("never equates a saved key with checked access", () => {
    const cache = new ConnectedAppAccessCache();
    expect(cache.status(true)).toMatchObject({ configured: true, checkedAt: "", tools: { available: false } });
    expect(cache.status(false).configured).toBe(false);
  });
  it("deduplicates in-flight checks and expires evidence", async () => {
    let now = 1000;
    const check = vi.fn(async () => evidence());
    const cache = new ConnectedAppAccessCache(check, () => now);
    await Promise.all([cache.refresh(cfg), cache.refresh(cfg)]);
    expect(check).toHaveBeenCalledOnce();
    const status = cache.status(true);
    status.tools.names.push("INJECTED");
    expect(cache.status(true).tools.names).not.toContain("INJECTED");
    now += 300_001;
    expect(cache.status(true)).toMatchObject({ tools: { available: false }, error: expect.stringContaining("Check app access") });
  });
  it("late checks cannot revive access after a credential change", async () => {
    let finish!: (value: ReturnType<typeof evidence>) => void;
    const cache = new ConnectedAppAccessCache(() => new Promise(resolve => { finish = resolve; }), () => 1000);
    const pending = cache.refresh(cfg);
    cache.invalidate();
    finish(evidence());
    await expect(pending).rejects.toMatchObject({ status: 409 });
    expect(cache.status(true).tools.available).toBe(false);
  });
  it("a failed check clears former evidence and sanitizes provider errors", async () => {
    const check = vi.fn().mockResolvedValueOnce(evidence()).mockRejectedValueOnce(new Error("private-key private-email"));
    const cache = new ConnectedAppAccessCache(check, () => 1000);
    await cache.refresh(cfg);
    const failed = await cache.refresh(cfg);
    expect(failed.tools.available).toBe(false);
    expect(JSON.stringify(failed)).not.toMatch(/private-key|private-email/);
    expect(failed.error).toContain("Could not verify app access");
  });
  it("keeps Platform key guidance when the saved key is the wrong kind", async () => {
    const check = vi.fn().mockRejectedValue(new Error("Use the Platform project API key (ak_…). For You / Connect consumer keys are not used."));
    const cache = new ConnectedAppAccessCache(check, () => 1000);
    const failed = await cache.refresh(cfg);
    expect(failed.error).toMatch(/ak_/);
    expect(failed.error).toMatch(/consumer keys are not used/);
    expect(cache.status(true).tools.available).toBe(false);
  });
  it("checks the same profile identity as worker execution", async () => {
    const check = vi.fn(async (_config: Parameters<typeof platformUserId>[0]) => evidence());
    const cache = new ConnectedAppAccessCache(check, () => 1000);
    const profileConfig = { ...cfg, profile: { email: "qa@example.invalid" } };
    await cache.refresh(profileConfig);
    expect(platformUserId(check.mock.calls[0][0])).toBe(platformUserId(profileConfig));
  });
});

describe("connected app configuration boundary", () => {
  it("allows explicit removal and trims write-only keys", () => {
    expect(connectedAppConfigPatch({ key: "  ak_sample  " })).toMatchObject({ key: "ak_sample", userId: expect.stringMatching(/^realbud-/) });
    expect(() => connectedAppConfigPatch({ key: "ck_sample" })).toThrow(/Platform project API key/);
    expect(connectedAppConfigPatch({ key: "" })).toEqual({ key: "" });
  });
  it.each([null, [], { key: 42 }, { key: "secret\nheader" }, { unknown: "value" },
    { url: "http://public.example/mcp" }, { url: "https://user:pass@example.com" },
    { url: "https://example.com/?api_key=secret" }, { key: "x".repeat(4097) }])("rejects unsafe config without echoing it", value => {
    expect(() => connectedAppConfigPatch(value)).toThrow("Invalid Connected apps settings");
  });
  it("accepts secure configured services and isolated loopback fixtures", () => {
    expect(connectedAppConfigPatch({ url: "https://connect.composio.dev/mcp" }).url).toBeDefined();
    expect(connectedAppConfigPatch({ url: "http://127.0.0.1:3456/mcp" }).url).toBeDefined();
  });
  it("keeps an existing account owner through key rotation and reconnection", () => {
    const rotated = connectedAppConfigPatch({ key: "ak_rotated_credential" }, cfg);
    expect(rotated.userId).toBe(platformUserId(cfg));
    const disconnected = { composio: { ...rotated, key: "" } };
    expect(connectedAppConfigPatch({ key: "ak_reconnected_credential" }, disconnected).userId).toBe(rotated.userId);
  });
  it("does not use an editable email as new account ownership and preserves an operator-bound identity", () => {
    expect(connectedAppConfigPatch({ key: "ak_new_credential" }, { profile: { email: "qa@example.invalid" } }).userId).toMatch(/^realbud-[a-f0-9-]{36}$/);
    const bound = { ...cfg, composio: { ...cfg.composio, userId: "realbud-existing-owner" } };
    expect(connectedAppConfigPatch({ key: "ak_new_credential" }, bound).userId).toBe("realbud-existing-owner");
  });
  it("does not accept a caller-selected identity and preserves ownership when clearing a legacy key", () => {
    expect(() => connectedAppConfigPatch({ key: "ak_new_credential", userId: "another-member" }, cfg)).toThrow("Invalid Connected apps settings");
    expect(connectedAppConfigPatch({ key: "" }, cfg)).toEqual({ key: "", userId: platformUserId(cfg) });
    expect(connectedAppConfigPatch({ key: "" }, {})).toEqual({ key: "" });
  });
  it("allows repair of an unsupported old key without carrying that credential forward", () => {
    const repaired = connectedAppConfigPatch({ key: "ak_new_credential" }, { composio: { key: "ck_legacy_consumer" } });
    expect(repaired.userId).toMatch(/^realbud-[a-f0-9-]{36}$/);
    expect(repaired.userId).not.toBe(platformUserId({ composio: { key: "ak_new_credential" } }));
  });
  it("keeps two new profiles separate under one project key and retains each binding after rotation", () => {
    const first = connectedAppConfigPatch({ key: "ak_shared_project" }, {});
    const second = connectedAppConfigPatch({ key: "ak_shared_project" }, {});
    expect(first.userId).not.toBe(second.userId);
    expect(platformUserId({ composio: first })).toBe(first.userId);
    expect(connectedAppConfigPatch({ key: "ak_rotated_project" }, { composio: first }).userId).toBe(first.userId);
    expect(connectedAppConfigPatch({ key: "ak_rotated_project" }, { composio: second }).userId).toBe(second.userId);
  });
});
