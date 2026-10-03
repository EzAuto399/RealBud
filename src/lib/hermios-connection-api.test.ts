import { describe, expect, it, vi } from "vitest";
vi.mock("@/state/store", () => ({ api: vi.fn() }));
import {
  HERMIOS_CONNECTION_API,
  HERMIOS_CONNECTION_CHECK_API,
  HERMIOS_CONNECTION_DISCONNECT_API,
  HERMIOS_CONNECTION_START_API,
} from "@shared/hermios-connection";
import { HERMIOS_STATE_UNREADABLE, createHermiosConnectionApi, openHermiosSignIn } from "./hermios-connection-api";

const account = { displayName: "Alex Example", workspaceLabel: "Example Realty", workspaceId: "ws-fixture", profileId: "profile-fixture", verifiedAt: 1_780_000_000_000 };
const notConnected = { version: 1, status: "not_connected", account: null, generation: 0, reason: null };
const connecting = { ...notConnected, status: "connecting", generation: 1 };
const connected = { version: 1, status: "connected", account, generation: 2, reason: null };
const authorizeUrl = "https://app.hermios.app/oauth/authorize?state=fixture-state";

/** Routes by path; a function value is called so a test can throw. */
function service(routes: Record<string, unknown>) {
  return vi.fn(async (path: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${path}`;
    const value = routes[key];
    if (value === undefined) throw new Error(`unexpected ${key}`);
    return typeof value === "function" ? (value as () => unknown)() : value;
  });
}
const offline = () => { throw new TypeError("fetch failed"); };
const http = (status: number) => () => { throw Object.assign(new Error("private server detail"), { status }); };

describe("reading Bud's Hermios connection", () => {
  it("returns the parsed state from GET only", async () => {
    const request = service({ [`GET ${HERMIOS_CONNECTION_API}`]: connected });
    await expect(createHermiosConnectionApi(request).state()).resolves.toEqual(connected);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an unknown status", { ...notConnected, status: "linked" }],
    ["a connected state without its account", { ...connected, account: null }],
    ["extra fields", { ...connected, token: "never" }],
    ["no body", undefined],
  ])("treats a malformed success (%s) as an error, never a guessed state", async (_label, body) => {
    const request = vi.fn(async () => body);
    await expect(createHermiosConnectionApi(request).state()).rejects.toThrow(HERMIOS_STATE_UNREADABLE);
  });

  it("reports a failed read with a fixed sentence, not the server's text", async () => {
    const request = service({ [`GET ${HERMIOS_CONNECTION_API}`]: http(500) });
    await expect(createHermiosConnectionApi(request).state()).rejects.toMatchObject({ message: HERMIOS_STATE_UNREADABLE, status: 500 });
  });
});

describe("changing Bud's Hermios connection", () => {
  it("starts a sign-in with a POST and returns only a Hermios https link", async () => {
    const request = service({ [`POST ${HERMIOS_CONNECTION_START_API}`]: { authorizeUrl } });
    await expect(createHermiosConnectionApi(request).start()).resolves.toEqual({ kind: "started", authorizeUrl });
    expect(request).toHaveBeenCalledWith(HERMIOS_CONNECTION_START_API, expect.objectContaining({ method: "POST" }), expect.anything());
  });

  it("never returns a link off hermios.app; it re-reads the state instead", async () => {
    const request = service({ [`POST ${HERMIOS_CONNECTION_START_API}`]: { authorizeUrl: "https://hermios.app.example.com/oauth" }, [`GET ${HERMIOS_CONNECTION_API}`]: connecting });
    await expect(createHermiosConnectionApi(request).start()).resolves.toEqual({ kind: "uncertain", state: connecting });
  });

  it("treats a lost answer after a POST as uncertain and re-reads, never as failed", async () => {
    for (const [path, call] of [[HERMIOS_CONNECTION_CHECK_API, "check"], [HERMIOS_CONNECTION_DISCONNECT_API, "disconnect"]] as const) {
      const request = service({ [`POST ${path}`]: offline, [`GET ${HERMIOS_CONNECTION_API}`]: notConnected });
      await expect(createHermiosConnectionApi(request)[call]()).resolves.toEqual({ kind: "uncertain", state: notConnected });
      expect(request).toHaveBeenCalledTimes(2);
    }
  });

  it("treats a server failure or malformed success as uncertain, and says so when the re-read fails too", async () => {
    let request = service({ [`POST ${HERMIOS_CONNECTION_DISCONNECT_API}`]: http(502), [`GET ${HERMIOS_CONNECTION_API}`]: offline });
    await expect(createHermiosConnectionApi(request).disconnect()).resolves.toEqual({ kind: "uncertain", state: null });
    request = service({ [`POST ${HERMIOS_CONNECTION_CHECK_API}`]: { ok: true }, [`GET ${HERMIOS_CONNECTION_API}`]: connected });
    await expect(createHermiosConnectionApi(request).check()).resolves.toEqual({ kind: "uncertain", state: connected });
  });

  it("separates a definite refusal from an unknown outcome, without echoing server text", async () => {
    const request = service({ [`POST ${HERMIOS_CONNECTION_START_API}`]: http(403), [`GET ${HERMIOS_CONNECTION_API}`]: notConnected });
    const outcome = await createHermiosConnectionApi(request).start();
    expect(outcome).toMatchObject({ kind: "refused", state: notConnected });
    expect(JSON.stringify(outcome)).not.toContain("private server detail");
  });

  it("settles check and disconnect on a well-formed state", async () => {
    const request = service({ [`POST ${HERMIOS_CONNECTION_CHECK_API}`]: connected, [`POST ${HERMIOS_CONNECTION_DISCONNECT_API}`]: { ...notConnected, generation: 3 } });
    const client = createHermiosConnectionApi(request);
    await expect(client.check()).resolves.toEqual({ kind: "settled", state: connected });
    await expect(client.disconnect()).resolves.toEqual({ kind: "settled", state: { ...notConnected, generation: 3 } });
    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe("opening the Hermios sign-in", () => {
  it("uses the desktop browser bridge and reports whether it opened", async () => {
    const openExternal = vi.fn(async () => true);
    await expect(openHermiosSignIn(authorizeUrl, { openExternal })).resolves.toBe(true);
    expect(openExternal).toHaveBeenCalledWith(authorizeUrl);
    await expect(openHermiosSignIn(authorizeUrl, { openExternal: vi.fn(async () => false) })).resolves.toBe(false);
    await expect(openHermiosSignIn(authorizeUrl, { openExternal: vi.fn(async () => { throw new Error("no"); }) })).resolves.toBe(false);
  });

  it("outside the desktop app opens a separate tab, never this window", async () => {
    const open = vi.fn(() => null);
    await expect(openHermiosSignIn(authorizeUrl, { open })).resolves.toBe(true);
    expect(open).toHaveBeenCalledWith(authorizeUrl, "_blank", "noopener,noreferrer");
  });

  it("refuses any link that isn't a Hermios https address", async () => {
    const openExternal = vi.fn(async () => true);
    for (const url of ["http://app.hermios.app/", "https://evil.example/hermios.app", "javascript:alert(1)"]) {
      await expect(openHermiosSignIn(url, { openExternal })).resolves.toBe(false);
    }
    expect(openExternal).not.toHaveBeenCalled();
  });
});
