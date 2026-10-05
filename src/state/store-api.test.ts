import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const BEFORE = "a".repeat(48), AFTER = "b".repeat(48);

describe("api() local session recovery", () => {
  let events: string[];
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  beforeEach(() => {
    vi.resetModules();
    events = [];
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  const stubWindow = (getLocalSession?: () => Promise<string>) => vi.stubGlobal("window", {
    ogb: getLocalSession ? { getLocalSession } : undefined,
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    dispatchEvent: (event: Event) => { events.push(event.type); return true; },
  });

  it("re-reads the desktop token after a 401 and retries once, never fetching /api/session for it", async () => {
    const bridge = vi.fn<() => Promise<string>>().mockResolvedValueOnce(BEFORE).mockResolvedValueOnce(AFTER);
    stubWindow(bridge);
    const { api } = await import("./store");
    fetchMock.mockResolvedValueOnce(json({ error: "session required" }, 401)).mockResolvedValueOnce(json({ ok: true }));
    expect(await api("/api/desk")).toEqual({ ok: true });
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(["/api/desk", "/api/desk"]);
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get("x-realbud-session")).toBe(AFTER);
    expect(events).not.toContain("realbud-local-session-required");
  });

  it("asks the owner to reconnect after a second refusal instead of retrying again", async () => {
    stubWindow(async () => BEFORE);
    const { api } = await import("./store");
    fetchMock.mockImplementation(async () => json({ error: "session required" }, 401));
    await expect(api("/api/desk")).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events).toContain("realbud-local-session-required");
  });
});
