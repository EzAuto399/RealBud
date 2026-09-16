import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});

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

  it("preserves binary audio and request headers, caches the ordinary session, and adds no administrator token", async () => {
    const admin = await import("./service-admin-session");
    const expiresAt = Date.now() + 60_000;
    admin.setServiceAdminSession({ token: "a".repeat(64), expiresAt,
      status: { managed: true, configured: true, authenticated: true, expiresAt, configurationError: false } });
    fetchMock.mockResolvedValueOnce(json({ token: "ordinary-fixture" }))
      .mockResolvedValueOnce(new Response(Uint8Array.from([0, 255, 42]), { headers: { "content-type": "audio/mpeg" } }))
      .mockResolvedValueOnce(json({ ready: true }));
    const requestHeaders = new Headers({ "content-type": "application/json", "x-realbud-session": "stale-caller-value" });
    const audio = await session.localSessionFetch("/api/tts/speak", { method: "POST", headers: requestHeaders, body: '{"text":"Fixture"}' });
    expect(audio.headers.get("content-type")).toBe("audio/mpeg");
    expect([...new Uint8Array(await audio.arrayBuffer())]).toEqual([0, 255, 42]);
    await session.localSessionFetch("/api/tts/prepare", { method: "POST", body: "{}" });
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(["/api/session", "/api/tts/speak", "/api/tts/prepare"]);
    const sent = fetchMock.mock.calls[1][1]!;
    const headers = new Headers(sent.headers);
    expect(headers.get("x-realbud-session")).toBe("ordinary-fixture");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.has("x-realbud-service-admin")).toBe(false);
    expect(sent.body).toBe('{"text":"Fixture"}');
    expect(requestHeaders.get("x-realbud-session")).toBe("stale-caller-value");
    admin.clearServiceAdminSession();
  });

  it("re-handshakes once after an explicit server-restart rejection and preserves the audio response", async () => {
    fetchMock.mockResolvedValueOnce(json({ token: "before-restart" }))
      .mockResolvedValueOnce(json({ error: "session required" }, 401))
      .mockResolvedValueOnce(json({ token: "after-restart" }))
      .mockResolvedValueOnce(new Response(Uint8Array.from([1, 2, 3])));
    const response = await session.localSessionFetch("/api/tts/speak", { method: "POST", body: "fixture-body" });
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3]);
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(["/api/session", "/api/tts/speak", "/api/session", "/api/tts/speak"]);
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get("x-realbud-session")).toBe("before-restart");
    expect(new Headers(fetchMock.mock.calls[3][1]?.headers).get("x-realbud-session")).toBe("after-restart");
    expect(fetchMock.mock.calls[3][1]?.body).toBe("fixture-body");
  });

  it.each([
    [402, "Managed service expired"], [403, "Voice is not included"],
    [401, "Provider authentication failed"], [500, "Provider failed"],
  ])("does not retry a %s operation failure and leaves its body readable", async (status, error) => {
    fetchMock.mockResolvedValueOnce(json({ token: "ordinary-fixture" })).mockResolvedValueOnce(json({ error }, status));
    const response = await session.localSessionFetch("/api/tts/speak", { method: "POST", body: "{}" });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a second handshake rejection or a malformed 401 response", async () => {
    fetchMock.mockResolvedValueOnce(json({ token: "first" }))
      .mockResolvedValueOnce(json({ error: "session required" }, 401))
      .mockResolvedValueOnce(json({ token: "second" }))
      .mockResolvedValueOnce(json({ error: "session required" }, 401))
      .mockResolvedValueOnce(new Response("non-JSON denial", { status: 401 }));
    expect((await session.localSessionFetch("/api/tts/speak", { method: "POST" })).status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(await (await session.localSessionFetch("/api/tts/speak", { method: "POST" })).text()).toBe("non-JSON denial");
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("never repeats an operation with an uncertain network outcome", async () => {
    fetchMock.mockResolvedValueOnce(json({ token: "ordinary-fixture" })).mockRejectedValueOnce(new TypeError("connection lost"));
    await expect(session.localSessionFetch("/api/tts/speak", { method: "POST" })).rejects.toThrow("connection lost");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not dispatch after cancellation while the handshake is pending", async () => {
    let finishHandshake!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { finishHandshake = resolve; }));
    const controller = new AbortController();
    const pending = session.localSessionFetch("/api/tts/speak", { method: "POST", signal: controller.signal });
    controller.abort();
    finishHandshake(json({ token: "ordinary-fixture" }));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(["/api/session"]);
  });

  it("does not dispatch an already-cancelled operation with a cached session", async () => {
    fetchMock.mockResolvedValueOnce(json({ token: "ordinary-fixture" }));
    await session.ensureSession();
    const controller = new AbortController(); controller.abort();
    await expect(session.localSessionFetch("/api/tts/speak", { method: "POST", signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([null, "", 42])("rejects an invalid handshake token %j without dispatch", async token => {
    fetchMock.mockResolvedValueOnce(json({ token }));
    await expect(session.localSessionFetch("/api/tts/speak", { method: "POST" })).rejects.toThrow("session refused");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["https://example.test/api/tts/speak", "//example.test/api/tts/speak", "/api/../secret", "/api/\\secret"])("refuses a non-local API target %s", async path => {
    await expect(session.localSessionFetch(path, { method: "POST" })).rejects.toThrow("Local API path required");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
