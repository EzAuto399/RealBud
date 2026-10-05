import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});
const BEFORE = "a".repeat(48), AFTER = "b".repeat(48);

function fakeWindow(ogb?: { getLocalSession?: () => Promise<string> }) {
  const storage = new Map<string, string>();
  const events: string[] = [];
  const win = {
    ogb,
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
    },
    dispatchEvent: (event: Event) => { events.push(event.type); return true; },
  };
  vi.stubGlobal("window", win);
  return { storage, events };
}

describe("ordinary local session fetch", () => {
  let session: typeof import("./local-session");
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  beforeEach(async () => {
    vi.resetModules();
    session = await import("./local-session");
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("gets the desktop token over IPC, never from HTTP, and adds no administrator token", async () => {
    const bridge = vi.fn(async () => BEFORE);
    fakeWindow({ getLocalSession: bridge });
    fetchMock.mockResolvedValueOnce(new Response(Uint8Array.from([0, 255, 42]), { headers: { "content-type": "audio/mpeg" } }))
      .mockResolvedValueOnce(json({ ready: true }));
    const requestHeaders = new Headers({ "content-type": "application/json", "x-realbud-session": "stale-caller-value" });
    const audio = await session.localSessionFetch("/api/tts/speak", { method: "POST", headers: requestHeaders, body: '{"text":"Fixture"}' });
    expect([...new Uint8Array(await audio.arrayBuffer())]).toEqual([0, 255, 42]);
    await session.localSessionFetch("/api/tts/prepare", { method: "POST", body: "{}" });
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(["/api/tts/speak", "/api/tts/prepare"]);
    expect(bridge).toHaveBeenCalledTimes(1);
    const headers = new Headers(fetchMock.mock.calls[0][1]!.headers);
    expect(headers.get("x-realbud-session")).toBe(BEFORE);
    expect(headers.has("x-realbud-service-admin")).toBe(false);
    expect(requestHeaders.get("x-realbud-session")).toBe("stale-caller-value");
  });

  it("recovers after a service restart by asking main again, once, without reloading", async () => {
    const bridge = vi.fn<() => Promise<string>>().mockResolvedValueOnce(BEFORE).mockResolvedValueOnce(AFTER);
    const { events } = fakeWindow({ getLocalSession: bridge });
    fetchMock.mockResolvedValueOnce(json({ error: "session required" }, 401))
      .mockResolvedValueOnce(new Response(Uint8Array.from([1, 2, 3])));
    const response = await session.localSessionFetch("/api/tts/speak", { method: "POST", body: "fixture-body" });
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3]);
    expect(bridge).toHaveBeenCalledTimes(2);
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get("x-realbud-session")).toBe(AFTER);
    expect(fetchMock.mock.calls[1][1]?.body).toBe("fixture-body");
    expect(events).toEqual([]);
  });

  it("stops after a second refusal and asks for reconnection instead of looping", async () => {
    const bridge = vi.fn(async () => BEFORE);
    const { events } = fakeWindow({ getLocalSession: bridge });
    fetchMock.mockImplementation(async () => json({ error: "session required" }, 401));
    expect((await session.localSessionFetch("/api/tts/speak", { method: "POST" })).status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events).toEqual([session.LOCAL_SESSION_REQUIRED_EVENT]);
  });

  it("uses only an owner-supplied token in a plain browser tab and clears it when refused", async () => {
    const { storage, events } = fakeWindow();
    await expect(session.ensureSession()).rejects.toMatchObject({ code: "local_session_required" });
    expect(events).toEqual([session.LOCAL_SESSION_REQUIRED_EVENT]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(() => session.setBrowserSessionToken("not-a-token")).toThrow();
    session.setBrowserSessionToken(BEFORE);
    expect(storage.get(session.BROWSER_SESSION_KEY)).toBe(BEFORE);
    // A forced refresh cannot mint a browser token; it reuses the owner's one.
    expect(await session.ensureSession(true)).toBe(BEFORE);
    fetchMock.mockImplementation(async () => json({ error: "session required" }, 401));
    await session.localSessionFetch("/api/tts/speak", { method: "POST" });
    expect(storage.has(session.BROWSER_SESSION_KEY)).toBe(false);
    await expect(session.ensureSession()).rejects.toMatchObject({ code: "local_session_required" });
  });

  it.each([
    [402, "Managed service expired"], [403, "Voice is not included"],
    [401, "Provider authentication failed"], [500, "Provider failed"],
  ])("does not retry a %s operation failure and leaves its body readable", async (status, error) => {
    fakeWindow({ getLocalSession: async () => BEFORE });
    fetchMock.mockResolvedValueOnce(json({ error }, status));
    const response = await session.localSessionFetch("/api/tts/speak", { method: "POST", body: "{}" });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never repeats an operation with an uncertain network outcome", async () => {
    fakeWindow({ getLocalSession: async () => BEFORE });
    fetchMock.mockRejectedValueOnce(new TypeError("connection lost"));
    await expect(session.localSessionFetch("/api/tts/speak", { method: "POST" })).rejects.toThrow("connection lost");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch after cancellation while main is still answering", async () => {
    let answer!: (token: string) => void;
    fakeWindow({ getLocalSession: () => new Promise(resolve => { answer = resolve; }) });
    const controller = new AbortController();
    const pending = session.localSessionFetch("/api/tts/speak", { method: "POST", signal: controller.signal });
    controller.abort();
    answer(BEFORE);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([null, "", 42, "fictional-short"])("rejects an invalid bridge token %j without dispatch", async token => {
    fakeWindow({ getLocalSession: async () => token as string });
    await expect(session.localSessionFetch("/api/tts/speak", { method: "POST" })).rejects.toThrow("session refused");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["https://example.test/api/tts/speak", "//example.test/api/tts/speak", "/api/../secret", "/api/\\secret"])("refuses a non-local API target %s", async path => {
    fakeWindow({ getLocalSession: async () => BEFORE });
    await expect(session.localSessionFetch(path, { method: "POST" })).rejects.toThrow("Local API path required");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
