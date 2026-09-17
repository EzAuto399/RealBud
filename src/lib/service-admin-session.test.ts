import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceAdminLogin, ServiceAdminStatus } from "../../shared/service-admin";

const START = 1_800_000_000_000;
const TOKEN_A = "a".repeat(64), TOKEN_B = "b".repeat(64);
const MINUTE = 60_000;
const status = (expiresAt: number | null, authenticated = true): ServiceAdminStatus => ({
  managed: true, configured: true, authenticated, expiresAt, configurationError: false,
});
const login = (token = TOKEN_A, expiresAt = START + 5 * MINUTE): ServiceAdminLogin => ({ token, expiresAt, status: status(expiresAt) });

describe("renderer service administrator session", () => {
  let admin: typeof import("./service-admin-session");
  let now: number;
  beforeEach(async () => {
    vi.resetModules();
    now = START;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    admin = await import("./service-admin-session");
  });
  afterEach(() => { admin.clearServiceAdminSession(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it("announces expiry without an API request or a mounted settings page", () => {
    vi.useFakeTimers();
    const listener = vi.fn();
    const unsubscribe = admin.subscribeServiceAdmin(listener);
    admin.setServiceAdminSession(login());
    expect(listener).toHaveBeenCalledTimes(1);
    now += 5 * MINUTE;
    vi.advanceTimersByTime(5 * MINUTE);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(admin.hasServiceAdminSession()).toBe(false);
    unsubscribe();
  });

  it("reschedules the renderer lock after an authorized settings change", () => {
    vi.useFakeTimers();
    const listener = vi.fn();
    const unsubscribe = admin.subscribeServiceAdmin(listener);
    admin.setServiceAdminSession(login());
    now += MINUTE;
    vi.advanceTimersByTime(MINUTE);
    admin.refreshServiceAdminExpiry(TOKEN_A, String(now + 5 * MINUTE));
    now = START + 5 * MINUTE;
    vi.advanceTimersByTime(4 * MINUTE);
    expect(admin.hasServiceAdminSession()).toBe(true);
    now += MINUTE;
    vi.advanceTimersByTime(MINUTE);
    expect(admin.hasServiceAdminSession()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("does not accept an old status response after switching administrator sessions", () => {
    admin.setServiceAdminSession(login(TOKEN_A));
    admin.setServiceAdminSession(login(TOKEN_B));
    expect(admin.refreshServiceAdminSession(status(null, false), TOKEN_A)).toBe(false);
    expect(admin.refreshServiceAdminSession(status(START + 10 * MINUTE), null)).toBe(false);
    expect(admin.serviceAdminHeaders()).toEqual({ "x-realbud-service-admin": TOKEN_B });
    admin.clearServiceAdminSession(TOKEN_A);
    admin.clearServiceAdminSession(null);
    expect(admin.serviceAdminHeaders()).toEqual({ "x-realbud-service-admin": TOKEN_B });
    admin.clearServiceAdminSession(TOKEN_B);
    expect(admin.serviceAdminHeaders()).toEqual({});
  });

  it("uses only the dedicated header and clears the renderer credential on logout", () => {
    expect(admin.serviceAdminHeaders()).toEqual({});
    admin.setServiceAdminSession(login());
    expect(admin.serviceAdminHeaders()).toEqual({ "x-realbud-service-admin": TOKEN_A });
    admin.clearServiceAdminSession();
    expect(admin.serviceAdminHeaders()).toEqual({});
    admin.refreshServiceAdminExpiry(TOKEN_A, String(START + 10 * MINUTE));
    expect(admin.serviceAdminHeaders()).toEqual({});
  });

  it("accepts the current request's renewed deadline without depending on a mounted settings view", () => {
    admin.setServiceAdminSession(login());
    now += 2 * MINUTE;
    admin.refreshServiceAdminExpiry(TOKEN_A, String(START + 7 * MINUTE));
    now = START + 6 * MINUTE;
    expect(admin.serviceAdminHeaders()).toEqual({ "x-realbud-service-admin": TOKEN_A });
    now = START + 7 * MINUTE;
    expect(admin.serviceAdminHeaders()).toEqual({});
  });

  it.each([TOKEN_A, null])("ignores an old or absent request token %s after a different login", requestToken => {
    admin.setServiceAdminSession(login());
    admin.clearServiceAdminSession();
    admin.setServiceAdminSession(login(TOKEN_B, START + MINUTE));
    admin.refreshServiceAdminExpiry(requestToken, String(START + 10 * MINUTE));
    now = START + MINUTE;
    expect(admin.serviceAdminHeaders()).toEqual({});
  });

  it.each([null, "", "NaN", "Infinity", "123.5", String(START), String(START + 16 * MINUTE)])("ignores an invalid or out-of-bounds expiry %s", expiry => {
    admin.setServiceAdminSession(login(TOKEN_A, START + MINUTE));
    admin.refreshServiceAdminExpiry(TOKEN_A, expiry);
    now = START + MINUTE;
    expect(admin.serviceAdminHeaders()).toEqual({});
  });

  it("does not revive a locally expired credential with a late mutation response", () => {
    admin.setServiceAdminSession(login(TOKEN_A, START + MINUTE));
    now = START + MINUTE;
    // Do not call headers first: expiry must be enforced by refresh itself.
    admin.refreshServiceAdminExpiry(TOKEN_A, String(START + 5 * MINUTE));
    expect(admin.serviceAdminHeaders()).toEqual({});
  });

  it("does not revive a locally expired credential with a late status response", () => {
    admin.setServiceAdminSession(login(TOKEN_A, START + MINUTE));
    now = START + MINUTE;
    admin.refreshServiceAdminSession(status(START + 5 * MINUTE));
    expect(admin.serviceAdminHeaders()).toEqual({});
  });

  it("refreshes an active status and clears it when the server reports revocation", () => {
    admin.setServiceAdminSession(login());
    now += MINUTE;
    admin.refreshServiceAdminSession(status(START + 6 * MINUTE));
    now = START + 5 * MINUTE;
    expect(admin.serviceAdminHeaders()).toEqual({ "x-realbud-service-admin": TOKEN_A });
    admin.refreshServiceAdminSession(status(null, false));
    expect(admin.serviceAdminHeaders()).toEqual({});
  });

  it.each([login("invalid"), login(TOKEN_A, START), login(TOKEN_A, NaN)])("rejects malformed or expired login results without replacing an active token", invalid => {
    admin.setServiceAdminSession(login(TOKEN_B));
    expect(() => admin.setServiceAdminSession(invalid)).toThrow("could not be confirmed");
    expect(admin.serviceAdminHeaders()).toEqual({ "x-realbud-service-admin": TOKEN_B });
  });
});
