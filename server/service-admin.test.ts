import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  SERVICE_ADMIN_HEADER, ServiceAdminAuthority, createServiceAdminPasswordVerifier,
  isPrivilegedServiceMutation, readServiceAdminPolicy, serviceAdminToken,
  verifyServiceAdminPassword, type ServiceAdminPolicy,
} from "./service-admin.ts";

const PASSWORD = "synthetic administrator password";
const FAKE_VERIFIER = `scrypt$32768$8$1$${"a".repeat(32)}$${"b".repeat(64)}`;
const request = (token: string) => ({ headers: { [SERVICE_ADMIN_HEADER]: token } });
let verifier: string;
let scratch: string;

beforeAll(async () => {
  verifier = await createServiceAdminPasswordVerifier(PASSWORD);
  scratch = mkdtempSync(join(tmpdir(), "realbud-service-admin-test-"));
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function rig(verifyPassword = vi.fn(async (password: string) => password === PASSWORD)) {
  let now = 1_000;
  let policy: ServiceAdminPolicy = { managed: true, passwordVerifier: FAKE_VERIFIER };
  const authority = new ServiceAdminAuthority({ loadPolicy: () => policy, now: () => now, verifyPassword });
  return { authority, verifyPassword, advance: (ms: number) => { now += ms; },
    policy: (next: ServiceAdminPolicy) => { policy = next; } };
}

describe("trusted administrator provisioning", () => {
  it("uses a salted scrypt verifier and checks the password without storing it", async () => {
    expect(verifier).not.toContain(PASSWORD);
    expect(await verifyServiceAdminPassword(PASSWORD, verifier)).toBe(true);
    expect(await verifyServiceAdminPassword("wrong synthetic password", verifier)).toBe(false);
    expect(await createServiceAdminPasswordVerifier(PASSWORD)).not.toBe(verifier);
  });

  it("rejects weak, oversized and malformed provisioning inputs", async () => {
    for (const password of ["short", "x".repeat(513), "界".repeat(400), "line\nbreak long password"]) {
      await expect(createServiceAdminPasswordVerifier(password)).rejects.toMatchObject({ status: 400 });
    }
    expect(await verifyServiceAdminPassword(PASSWORD, verifier.replace("32768", "999999999"))).toBe(false);
    expect(await verifyServiceAdminPassword(PASSWORD, "plaintext password")).toBe(false);
  });

  it("keeps missing managed provisioning locked and lets the server choose a development default", () => {
    const path = join(scratch, "absent.json");
    expect(readServiceAdminPolicy({ path })).toEqual({ managed: true, passwordVerifier: null, configurationError: false });
    expect(readServiceAdminPolicy({ path, managedDefault: false }).managed).toBe(false);
  });

  it("configured or malformed policy cannot disable managed mode", () => {
    const path = join(scratch, "policy.json");
    writeFileSync(path, JSON.stringify({ version: 1, passwordVerifier: verifier }));
    expect(readServiceAdminPolicy({ path, managedDefault: false })).toEqual({ managed: true, passwordVerifier: verifier });
    for (const value of ["{", JSON.stringify({ version: 1, passwordVerifier: "plaintext" }),
      JSON.stringify({ version: 1, passwordVerifier: verifier, managed: false }), " ".repeat(4097)]) {
      writeFileSync(path, value);
      expect(readServiceAdminPolicy({ path, managedDefault: false })).toEqual({ managed: true, passwordVerifier: null, configurationError: true });
    }
  });
});

describe("administrator sessions", () => {
  it("authenticates against the real verifier with an opaque request-specific token", async () => {
    const authority = new ServiceAdminAuthority({ loadPolicy: () => ({ managed: true, passwordVerifier: verifier }) });
    const result = await authority.login(PASSWORD);
    expect(result.token).toMatch(/^[a-f0-9]{64}$/);
    expect(authority.authorize(request(result.token)).ok).toBe(true);
    expect(authority.status()).toMatchObject({ authenticated: false, expiresAt: null });
    const publicStatus = JSON.stringify(authority.status(request(result.token)));
    for (const privateValue of [PASSWORD, verifier, result.token]) expect(publicStatus).not.toContain(privateValue);
  });

  it("rejects app tokens, bearer/query tokens, duplicate headers and office-role claims", async () => {
    const { authority } = rig();
    const { token } = await authority.login(PASSWORD);
    const ordinary = { headers: { authorization: `Bearer ${token}`, "x-realbud-session": token }, url: `/?session=${token}`, role: "owner" };
    expect(serviceAdminToken(ordinary)).toBeNull();
    expect(authority.authorize(ordinary)).toMatchObject({ ok: false, status: 401 });
    expect(serviceAdminToken({ headers: { [SERVICE_ADMIN_HEADER]: [token, token] } })).toBeNull();
    expect(serviceAdminToken(request(`${token} `))).toBeNull();
  });

  it("logout revokes only its session, and a new authority cannot reuse old tokens", async () => {
    const { authority } = rig();
    const first = await authority.login(PASSWORD), second = await authority.login(PASSWORD);
    expect(first.token).not.toBe(second.token);
    expect(authority.logout(request(first.token)).authenticated).toBe(false);
    expect(authority.authorize(request(first.token)).ok).toBe(false);
    expect(authority.authorize(request(second.token)).ok).toBe(true);
    expect(rig().authority.authorize(request(second.token)).ok).toBe(false);
  });

  it("status polling does not extend the five-minute idle expiry", async () => {
    const { authority, advance } = rig();
    const signedIn = await authority.login(PASSWORD);
    advance(4 * 60_000);
    expect(authority.status(request(signedIn.token)).authenticated).toBe(true);
    advance(60_000);
    expect(authority.authorize(request(signedIn.token))).toMatchObject({ ok: false, status: 401 });
  });

  it("authorized work extends idle time but never the fifteen-minute absolute expiry", async () => {
    const { authority, advance } = rig();
    const signedIn = await authority.login(PASSWORD);
    for (let index = 0; index < 3; index++) {
      advance(4 * 60_000);
      expect(authority.authorize(request(signedIn.token)).ok).toBe(true);
    }
    advance(3 * 60_000);
    expect(authority.authorize(request(signedIn.token)).ok).toBe(false);
  });

  it("revokes sessions when the policy changes, becomes unreadable, or the clock moves backwards", async () => {
    const test = rig();
    const signedIn = await test.authority.login(PASSWORD);
    test.policy({ managed: true, passwordVerifier: verifier });
    expect(test.authority.authorize(request(signedIn.token)).ok).toBe(false);
    const next = await test.authority.login(PASSWORD);
    test.advance(-1);
    expect(test.authority.authorize(request(next.token)).ok).toBe(false);
    test.policy({ managed: true, passwordVerifier: FAKE_VERIFIER, configurationError: true });
    expect(test.authority.authorize(request(next.token))).toMatchObject({ ok: false, status: 403 });
  });

  it("missing or failing provisioning never creates administrator authority", async () => {
    for (const loadPolicy of [() => ({ managed: true, passwordVerifier: null }), () => { throw new Error("private path"); }]) {
      const authority = new ServiceAdminAuthority({ loadPolicy });
      await expect(authority.login(PASSWORD)).rejects.toMatchObject({ status: 403 });
      expect(authority.authorize().ok).toBe(false);
      expect(JSON.stringify(authority.status())).not.toContain("private path");
    }
  });

  it("reserves attempts before verification and throttles repeated failures without a timer", async () => {
    const test = rig();
    for (let index = 0; index < 5; index++) {
      await expect(test.authority.login("wrong password")).rejects.toMatchObject({ status: 401 });
    }
    await expect(test.authority.login(PASSWORD)).rejects.toMatchObject({ status: 429, retryAfterSeconds: 300 });
    expect(test.verifyPassword).toHaveBeenCalledTimes(5);
    test.advance(5 * 60_000);
    expect((await test.authority.login(PASSWORD)).status.authenticated).toBe(true);
  });

  it("bounds concurrent password work and refuses promotion after a policy change", async () => {
    let finish!: (value: boolean) => void;
    const verify = vi.fn((_password: string) => new Promise<boolean>(resolve => { finish = resolve; }));
    const test = rig(verify);
    const pending = test.authority.login(PASSWORD);
    await expect(test.authority.login(PASSWORD)).rejects.toMatchObject({ status: 429 });
    expect(verify).toHaveBeenCalledTimes(1);
    test.policy({ managed: true, passwordVerifier: verifier });
    finish(true);
    await expect(pending).rejects.toMatchObject({ status: 401 });
    expect(test.authority.status().authenticated).toBe(false);
  });

  it("keeps throttling bounded when the wall clock moves backwards", async () => {
    const test = rig();
    for (let index = 0; index < 5; index++) {
      await expect(test.authority.login("wrong password")).rejects.toMatchObject({ status: 401 });
    }
    test.advance(-24 * 60 * 60_000);
    await expect(test.authority.login(PASSWORD)).rejects.toMatchObject({ status: 429, retryAfterSeconds: 300 });
    test.advance(5 * 60_000);
    expect((await test.authority.login(PASSWORD)).status.authenticated).toBe(true);
  });

  it("rejects malformed login bodies before invoking a password verifier", async () => {
    const test = rig();
    for (const value of [null, {}, [PASSWORD], "", "x".repeat(513), "界".repeat(400), "bad\0password"]) {
      await expect(test.authority.login(value)).rejects.toMatchObject({ status: 400 });
    }
    expect(test.verifyPassword).not.toHaveBeenCalled();
  });
});

describe("service mutation route contract", () => {
  it.each([
    ["POST", "/api/hermes/model", { providerId: "openai", apiKey: "replacement", baseUrl: "https://example.test" }],
    ["POST", "/api/hermes/oauth/start", { providerId: "openai-codex" }],
    ["POST", "/api/hermes/oauth/cancel", {}],
    ["POST", "/api/hermes/update/restore", {}],
    ["POST", "/api/hermes/uninstall", {}],
    ["POST", "/api/hermes/repair", {}],
    ["POST", "/api/hermes/apply-pack", {}],
    ["POST", "/api/instances/other/setup", {}],
    ["PATCH", "/api/bots/bud", { modelSelection: { instanceId: "other", model: "other" } }],
    ["PUT", "/api/config", { xai: { key: "replacement" } }],
    ["PATCH", "/api/config", { tts: { key: "" } }],
    ["PUT", "/api/config", { box: { token: "replacement" } }],
    ["PATCH", "/api/config", { profile: { name: "Office owner" }, composio: { apiKey: "replacement" } }],
    ["PATCH", "/api/config", { composio: { key: "", url: "https://example.test" } }],
    ["PATCH", "/api/config", []],
    ["POST", "/api/connected-apps/gmail-readonly/setup", {}],
    ["POST", "/api/connected-apps/mode", { mode: "consumer" }],
    ["POST", "/api/channels/slack", { botToken: "replacement", appToken: "replacement" }],
    ["DELETE", "/api/channels/telegram", undefined],
    ["POST", "/api/local-computer/pull", {}],
  ])("requires administrator authority for %s %s", (method, path, body) => {
    expect(isPrivilegedServiceMutation(path as string, method as string, body)).toBe(true);
  });

  it.each([
    ["GET", "/api/hermes/model", undefined],
    ["POST", "/api/hermes/memory-reviews/1234abcd/decision", { expectedDigest: 'a'.repeat(64), decision: 'approve' }],
    ["POST", "/api/care/unlock", { secret: PASSWORD }],
    ["POST", "/api/care/lock", {}],
    ["PATCH", "/api/config", { profile: { name: "Member", email: "member@example.test" }, tts: { voice: "voice-id" } }],
    ["PATCH", "/api/bots/bud", { title: "Work" }],
    ["PATCH", "/api/connected-apps/sources/gmail", { enabled: false }],
    ["PATCH", "/api/connected-apps/sources/gmail", { accountId: "ca_personal", enabled: true }],
    ["POST", "/api/connectors/gmail/authorize", {}],
    ["POST", "/api/channels/slack/pair", {}],
    ["POST", "/api/local-computer/stop", {}],
    ["POST", "/api/bots/bud/interrupt", {}],
    ["POST", "/api/tts/speak", { text: "Read this" }],
  ])("leaves existing member, entitlement and safety policy responsible for %s %s", (method, path, body) => {
    expect(isPrivilegedServiceMutation(path as string, method as string, body)).toBe(false);
  });
});
