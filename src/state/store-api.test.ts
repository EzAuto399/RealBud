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

  it("sends the tab's office member session only on approval changes, answers and the person's own turn-starting messages", async () => {
    const member = "fictional_member_session_000000000000000000";
    vi.stubGlobal("window", {
      ogb: { getLocalSession: async () => BEFORE },
      sessionStorage: { getItem: (key: string) => key === "realbud.company-member-session" ? member : null, setItem: () => {}, removeItem: () => {} },
      dispatchEvent: () => true,
    });
    const { api } = await import("./store");
    fetchMock.mockImplementation(async () => json({ ok: true }));
    const paths = ["/api/rules", "/api/rules/fictional-rule", "/api/approvals", "/api/approvals/history?departmentId=x", "/api/threads/t-1/respond", "/api/bots/bud/respond",
      "/api/bots/bud/messages", "/api/bots/bud/steer", "/api/bots/bud/queued-message", "/api/bots/bud/messages/m-1/edit",
      "/api/desk", "/api/company/me", "/api/rulesets", "/api/bots/bud/interrupt", "/api/bots/bud/messages/m-1/edit/x", "/api/bots", "/api/bots/bud/cards/m-1"];
    for (const path of paths) await api(path, { method: "POST", body: "{}" });
    const sent = fetchMock.mock.calls.map(([path, init]) => [path, new Headers(init?.headers).get("x-realbud-member-session")]);
    expect(sent).toEqual(paths.map((path, index) => [path, index < 10 ? member : null]));
  });

  it("words a failed request as busy only when the health check answers busy, and as not responding when nothing answers", async () => {
    const details: unknown[] = [];
    vi.stubGlobal("window", {
      ogb: { getLocalSession: async () => BEFORE },
      sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      dispatchEvent: (event: Event) => { details.push((event as CustomEvent).detail); return true; },
    });
    const { api } = await import("./store");
    const { LOCAL_SERVICE_BUSY, LOCAL_SERVICE_UNAVAILABLE } = await import("@/lib/api-error");
    const timedOut = () => Promise.reject(new DOMException("signal timed out", "TimeoutError"));
    fetchMock.mockImplementation(async (path) => path === "/api/health" ? json({ app: "realbud", busy: true }) : timedOut());
    await expect(api("/api/desk")).rejects.toThrow(LOCAL_SERVICE_BUSY);
    fetchMock.mockImplementation(async () => { throw new TypeError("Failed to fetch"); });
    await expect(api("/api/desk")).rejects.toThrow(LOCAL_SERVICE_UNAVAILABLE);
    // Answering but not busy, or a foreign answer, is not proof the service is merely slow.
    fetchMock.mockImplementation(async (path) => path === "/api/health" ? json({ app: "other", busy: true }) : timedOut());
    await expect(api("/api/desk")).rejects.toThrow(LOCAL_SERVICE_UNAVAILABLE);
    expect(details).toEqual([{ busy: true }, { busy: false }, { busy: false }]);
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
