// Two actual HTTP harnesses, separate installation passwords, disposable data.
// No live providers, personal accounts, desktop control or billing service.
import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServiceAdminPasswordVerifier } from "./service-admin.ts";
import { canonicalServiceEntitlementPayload } from "./service-entitlement.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(join(tmpdir(), "realbud-admin-http-"));
const keys = generateKeyPairSync("ed25519");
type Installation = { data: string; password: string; base: string; session: string; child: ChildProcess };
const installations: Installation[] = [];

function grant(installation: Installation, expiresAt: number) {
  const payload = canonicalServiceEntitlementPayload({ schema: 1, licenseId: "fixture-license", companyId: "fixture-company",
    hostInstallationId: installation.data.endsWith("A") ? "fixture-A" : "fixture-B", issuedAt: Date.now() - 60_000,
    notBefore: Date.now() - 30_000, expiresAt, capabilities: ["reasoning", "connected-tools", "computer-use", "voice"] });
  writeFileSync(join(installation.data, "service-entitlement.json"), JSON.stringify({ schema: 1, keyId: "fixture-key", payload,
    signature: sign(null, Buffer.from(payload), keys.privateKey).toString("base64url") }), { mode: 0o600 });
}

async function request(instance: Installation, path: string, method = "GET", body?: unknown, token?: string) {
  const response = await fetch(instance.base + path, { method, signal: AbortSignal.timeout(10_000),
    headers: { "content-type": "application/json", "x-realbud-session": instance.session, ...(token ? { "x-realbud-service-admin": token } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() as Record<string, any>, cache: response.headers.get("cache-control") };
}

beforeAll(async () => {
  for (const name of ["A", "B"]) {
    const data = join(root, name); mkdirSync(data, { mode: 0o700 });
    const password = `Fictional-${name}-separate-admin-2026!`;
    writeFileSync(join(data, "config.json"), JSON.stringify({ profile: { name: `Fixture ${name}` },
      instances: { fixture: { driver: "not-a-real-driver" } }, composio: { key: "ak_fictional-never-contact-provider" } }));
    writeFileSync(join(data, "service-admin.json"), JSON.stringify({ version: 1, passwordVerifier: await createServiceAdminPasswordVerifier(password) }), { mode: 0o600 });
    writeFileSync(join(data, "service-installation.json"), JSON.stringify({ schema: 1, companyId: "fixture-company", hostInstallationId: `fixture-${name}` }));
    writeFileSync(join(data, "service-trust-keys.json"), JSON.stringify({ schema: 1, keys: [{ keyId: "fixture-key", publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }) }] }));
    const socket = createServer(); socket.listen(0, "127.0.0.1"); await once(socket, "listening");
    const port = (socket.address() as { port: number }).port;
    await new Promise<void>(resolve => socket.close(() => resolve()));
    const child = spawn(process.execPath, ["--experimental-strip-types", "server/index.ts"], { cwd: ROOT,
      env: { PATH: process.env.PATH || "", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: data, USERPROFILE: data, REALBUD_DATA_DIR: data, REALBUD_HERMES_HOME: join(data, "hermes"),
        HERMES_HOME: join(data, "hermes"), OMB_PORT: String(port), VITEST: "true",
        REALBUD_MANAGED_SERVICE: "1", REALBUD_SERVICE_ENTITLEMENT_REQUIRED: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.resume(); child.stderr?.resume();
    const instance = { data, password, child, base: `http://127.0.0.1:${port}`, session: "" };
    installations.push(instance);
    for (let attempt = 0; attempt < 150; attempt++) {
      if (child.exitCode !== null) throw new Error("Disposable service exited.");
      if (await fetch(instance.base + "/api/health").then(r => r.ok, () => false)) break;
      if (attempt === 149) throw new Error("Disposable service startup timed out.");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    instance.session = ((await (await fetch(instance.base + "/api/session")).json()) as { token: string }).token;
    grant(instance, Date.now() + 60_000);
  }
}, 40_000);

afterAll(async () => {
  for (const instance of installations) {
    if (instance.child.exitCode === null && instance.child.signalCode === null) {
      const stopped = once(instance.child, "exit"); instance.child.kill("SIGTERM");
      const timer = setTimeout(() => instance.child.kill("SIGKILL"), 5000);
      await stopped; clearTimeout(timer);
    }
  }
  rmSync(root, { recursive: true, force: true });
});

describe("managed service through the real HTTP boundary", () => {
  it("keeps configured keys write-only and provider setup private", async () => {
    const a = installations[0]!;
    const config = await request(a, "/api/config");
    expect(config.status).toBe(200);
    expect(config.body.composio.configured).toBe(true);
    expect(config.body.serviceAdmin).toMatchObject({ managed: true, authenticated: false });
    expect(JSON.stringify(config.body)).not.toContain("ak_fictional");
    expect((await request(a, "/api/hermes/oauth/status?sessionId=fixture")).body.code).toBe("service_admin_required");
  });

  it("blocks key replacement, removal, provider switching and technical setup without changing stored data", async () => {
    const a = installations[0]!;
    const before = readFileSync(join(a.data, "config.json"));
    for (const [path, method, body] of [
      ["/api/config", "PUT", { composio: { key: "" } }],
      ["/api/config?ignored=1", "PATCH", { composio: { apiKey: "ak_replacement" } }],
      ["/api/hermes/model", "POST", { providerId: "openai", apiKey: "replacement" }],
      ["/api/bots/bud", "PATCH", { modelSelection: { instanceId: "own", model: "own" } }],
      ["/api/hermes/repair", "POST", {}],
      ["/api/connected-apps/mode", "POST", { mode: "consumer" }],
    ] as const) {
      const result = await request(a, path, method, body);
      expect(result.status, path).toBe(401);
      expect(result.body.code, path).toBe("service_admin_required");
    }
    expect(readFileSync(join(a.data, "config.json"))).toEqual(before);
  });

  it("isolates passwords and administrator sessions between installations and windows", async () => {
    const [a, b] = installations as [Installation, Installation];
    expect((await request(b, "/api/service-admin/login", "POST", { password: a.password })).status).toBe(401);
    const loginA = await request(a, "/api/service-admin/login", "POST", { password: a.password });
    const loginB = await request(b, "/api/service-admin/login", "POST", { password: b.password });
    expect(loginA.status).toBe(200); expect(loginB.status).toBe(200);
    const token = loginA.body.token;
    expect((await request(a, "/api/service-admin/status", "GET", undefined, token)).body.authenticated).toBe(true);
    expect((await request(a, "/api/service-admin/status")).body.authenticated).toBe(false);
    expect((await request(b, "/api/service-admin/status", "GET", undefined, token)).body.authenticated).toBe(false);
    // Clearing a key is a real privileged write; no provider request is needed.
    expect((await request(a, "/api/config", "PUT", { composio: { key: "" } }, token)).status).toBe(200);
    expect((await request(a, "/api/config")).body.composio.configured).toBe(false);
    expect((await request(b, "/api/config")).body.composio.configured).toBe(true);
    await request(a, "/api/service-admin/logout", "POST", {}, token);
    expect((await request(a, "/api/config", "PUT", { composio: { key: "" } }, token)).body.code).toBe("service_admin_required");
    expect((await request(b, "/api/service-admin/status", "GET", undefined, loginB.body.token)).body.authenticated).toBe(true);
  });

  it("denies paid work on expiry even to the administrator while preserving records, preferences and Stop", async () => {
    const a = installations[0]!;
    const token = (await request(a, "/api/service-admin/login", "POST", { password: a.password })).body.token;
    expect((await request(a, "/api/service/status")).body.state).toBe("active");
    grant(a, Date.now() - 1000);
    const status = await request(a, "/api/service/status");
    expect(status.body.state).toBe("expired"); expect(status.cache).toBe("no-store");
    const ping = await request(a, "/api/hermes/test", "POST", {}, token);
    expect(ping.body).toMatchObject({ ok: false, detail: expect.stringContaining("expired") });
    expect((await request(a, "/api/tts/speak", "POST", { text: "Fictional fixture" }, token)).status).toBe(402);
    expect((await request(a, "/api/desk")).status).toBe(200);
    expect((await request(a, "/api/config", "PATCH", { profile: { name: "Staff can still update preferences" } })).status).toBe(200);
    const stop = await request(a, "/api/bots/bud/interrupt", "POST", {});
    expect(stop.status).toBe(200);
    expect(stop.body).toMatchObject({ ok: true });
    // Recovery is a newly verified grant, never administrator login alone.
    grant(a, Date.now() + 60_000);
    expect((await request(a, "/api/service/status")).body.state).toBe("active");
  });
});
