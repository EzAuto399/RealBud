import { describe, expect, it, vi } from "vitest";
vi.mock("@/state/store", () => ({ api: vi.fn() }));
import { CONNECTOR_STATE_UNREADABLE, createConnectorApi, openConnectorSignIn } from "./redbark-connection-api";

const base = "/api/connectors/redbark/connection";
const notConnected = { version: 1, connector: "redbark", status: "not_connected", account: null, generation: 0, reason: null, canManage: true };
const connected = { ...notConnected, status: "connected", account: { label: "Fictional Bank · 1 account", verifiedAt: 1_780_000_000_000 }, generation: 1 };
const authorizeUrl = "https://app.redbark.com/oauth/authorize?state=fixture-state";

function service(routes: Record<string, unknown>) {
  return vi.fn(async (path: string, init?: RequestInit) => {
    const value = routes[`${init?.method ?? "GET"} ${path}`];
    if (value === undefined) throw new Error(`unexpected ${init?.method ?? "GET"} ${path}`);
    return typeof value === "function" ? (value as () => unknown)() : value;
  });
}
const http = (status: number) => () => { throw Object.assign(new Error("private server detail"), { status }); };

describe("connector client", () => {
  it("reads the parsed state by connector id and refuses a malformed or foreign one", async () => {
    await expect(createConnectorApi(service({ [`GET ${base}`]: connected })).state()).resolves.toEqual(connected);
    await expect(createConnectorApi(service({ [`GET ${base}`]: { ...connected, connector: "other" } })).state()).rejects.toThrow(CONNECTOR_STATE_UNREADABLE);
    await expect(createConnectorApi(service({ [`GET ${base}`]: { ...connected, token: "x" } })).state()).rejects.toThrow(CONNECTOR_STATE_UNREADABLE);
  });

  it("starts with an empty JSON body and accepts only a Redbark sign-in link", async () => {
    const request = service({ [`POST ${base}/start`]: { authorizeUrl } });
    await expect(createConnectorApi(request).start()).resolves.toEqual({ kind: "started", authorizeUrl });
    expect(request).toHaveBeenCalledWith(`${base}/start`, { method: "POST", body: "{}" }, expect.anything());
    const foreign = service({ [`POST ${base}/start`]: { authorizeUrl: "https://evil.example.test/authorize" }, [`GET ${base}`]: notConnected });
    await expect(createConnectorApi(foreign).start()).resolves.toMatchObject({ kind: "uncertain" });
  });

  it("explains an owner-only refusal and treats a lost reply as uncertain", async () => {
    const refused = service({ [`POST ${base}/disconnect`]: http(403), [`GET ${base}`]: connected });
    await expect(createConnectorApi(refused).disconnect()).resolves.toEqual({ kind: "refused", message: "Only the office owner or an administrator can change this connection.", state: connected });
    const lost = service({ [`POST ${base}/check`]: http(500), [`GET ${base}`]: connected });
    await expect(createConnectorApi(lost).check()).resolves.toEqual({ kind: "uncertain", state: connected });
  });

  it("opens only a link on the expected origin, outside this window", async () => {
    const openExternal = vi.fn(async () => true);
    await expect(openConnectorSignIn(authorizeUrl, "https://app.redbark.com", { openExternal })).resolves.toBe(true);
    await expect(openConnectorSignIn("https://evil.example.test/", "https://app.redbark.com", { openExternal })).resolves.toBe(false);
    expect(openExternal).toHaveBeenCalledTimes(1);
  });
});
