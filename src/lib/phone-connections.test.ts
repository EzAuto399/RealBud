import { describe, expect, it, vi } from "vitest";
import { createPhoneConnections } from "./phone-connections";
vi.mock("@/state/store", () => ({ api: vi.fn() }));

const off = () => ({ telegram: { connected: false as const }, discord: { connected: false as const }, slack: { connected: false as const } });
const on = () => ({ ...off(), telegram: { connected: true as const, botUsername: "fixture", paired: true, pairedName: "Fictional PM", lastMessageAt: 1 } });
describe("one phone connection roster", () => {
  it("coalesces concurrent refreshes", async () => {
    const request = vi.fn(async () => on());
    const store = createPhoneConnections(request);
    await Promise.all([store.refresh(), store.refresh()]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().channels?.telegram.connected).toBe(true);
  });
  it("does not resurrect a disconnected account with a late refresh", async () => {
    let finish!: (body: unknown) => void;
    const store = createPhoneConnections(() => new Promise(resolve => { finish = resolve; }));
    const pending = store.refresh();
    await Promise.resolve();
    store.replace(off());
    finish(on()); await pending;
    expect(store.getSnapshot().channels?.telegram.connected).toBe(false);
  });
  it("merges a valid partial event without removing the other apps", () => {
    const store = createPhoneConnections(async () => off());
    store.replace(on());
    store.patch({ slack: on().telegram });
    expect(store.getSnapshot().channels?.telegram.connected).toBe(true);
    expect(store.getSnapshot().channels?.slack.connected).toBe(true);
  });
  it.each([null, {}, { telegram: { connected: true } }, { telegram: {}, discord: {}, slack: {} }])("does not call malformed status ready", async payload => {
    const store = createPhoneConnections(async () => payload);
    store.replace(on()); await store.refresh();
    expect(store.getSnapshot().channels).toBeNull();
    expect(store.getSnapshot().error).toContain("Couldn’t check");
  });
  it("recovers from an immediate request failure", async () => {
    const request = vi.fn().mockImplementationOnce(() => { throw new Error("offline"); }).mockResolvedValueOnce(on());
    const store = createPhoneConnections(request);
    await store.refresh(); expect(store.getSnapshot().error).not.toBe("");
    await store.refresh(); expect(store.getSnapshot().error).toBe("");
    expect(store.getSnapshot().channels?.telegram.connected).toBe(true);
  });
});
