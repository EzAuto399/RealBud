import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServiceAdminPasswordVerifier } from "./service-admin.ts";
import { startCompanyPostgresFixture } from "./company/testing-postgres.ts";

// Explicit real-Postgres gate. Ordinary test runs report this suite as skipped
// if the toolchain is absent; the dedicated local acceptance run enables it.
describe.runIf(process.env.REALBUD_TEST_POSTGRES === "1")("company + service administration through the real HTTP server", () => {
  let fixture: Awaited<ReturnType<typeof startCompanyPostgresFixture>>;
  let child: ChildProcess | undefined;
  let companionChild: ChildProcess | undefined;
  let companionBase = "";
  let companionSession = "";
  let data: string;
  let base: string;
  let appSession = "";
  let owner = "";
  let member = "";
  let administrator = "";
  let oldAdministrator = "";
  let privateScope = "";
  let companyScope = "";
  const ownerCredential = { loginName: "alice", password: "Synthetic-owner-password-2026" };
  const memberCredential = { loginName: "bobby", password: "Synthetic-member-password-2026" };
  const password = "Synthetic-service-admin-2026";

  async function request(method: string, path: string, body?: unknown, options: { admin?: string; member?: string; noAppSession?: boolean; companion?: boolean } = {}) {
    const response = await fetch((options.companion ? companionBase : base) + path, { method, headers: {
      "content-type": "application/json",
      ...(!options.noAppSession && appSession ? { "x-realbud-session": options.companion ? companionSession : appSession } : {}),
      ...(options.admin ? { "x-realbud-service-admin": options.admin } : {}),
      ...(options.member ? { "x-realbud-member-session": options.member } : {}),
    }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  }

  async function stopServer() {
    if (!child || child.exitCode !== null) return;
    const stopped = once(child, "exit");
    child.kill("SIGTERM");
    const force = setTimeout(() => child?.kill("SIGKILL"), 5000);
    await stopped;
    clearTimeout(force);
    child = undefined;
  }

  async function startServer(companion = false) {
    const socket = createServer();
    socket.listen(0, "127.0.0.1"); await once(socket, "listening");
    const port = (socket.address() as { port: number }).port;
    await new Promise<void>(resolve => socket.close(() => resolve()));
    const origin = `http://127.0.0.1:${port}`;
    if (companion) companionBase = origin; else base = origin;
    const profile = companion ? join(data, "companion") : data;
    if (companion) { await mkdir(profile, { mode: 0o700 }); await writeFile(join(profile, "config.json"), JSON.stringify({ instances: { ghost: { driver: "not-a-real-driver" } } }), { mode: 0o600 }); }
    const launched = spawn(process.execPath, ["--experimental-strip-types", "server/index.ts"], {
      cwd: process.cwd(), env: { ...process.env, OMB_PORT: String(port), OMB_TEST_FLEET: "1", VITEST: "1",
        REALBUD_DATA_DIR: profile, OMB_DATA_DIR: profile, REALBUD_HERMES_HOME: join(profile, "hermes"), HERMES_HOME: join(profile, "hermes"),
        REALBUD_COMPANY_DATABASE_URL: fixture.applicationUrl, REALBUD_MANAGED_SERVICE: "1", REALBUD_SERVICE_ENTITLEMENT_REQUIRED: "1",
        REALBUD_SERVICE_ADMIN_FILE: join(data, "service-admin.json"),
      }, stdio: ["ignore", "pipe", "pipe"],
    });
    // Consume output without storing source/account content or environment.
    if (companion) companionChild = launched; else child = launched;
    launched.stdout?.resume(); launched.stderr?.resume();
    let healthy = false;
    for (let attempt = 0; attempt < 150; attempt++) {
      if (launched.exitCode !== null) throw new Error("Isolated RealBud service exited before health became available.");
      try { healthy = (await fetch(origin + "/api/health")).ok; } catch { /* starting */ }
      if (healthy) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(healthy).toBe(true);
    const session = (await request("GET", "/api/session", undefined, { noAppSession: true, companion })).body.token;
    if (companion) companionSession = session; else appSession = session;
  }

  beforeAll(async () => {
    data = await mkdtemp(join(tmpdir(), "realbud-company-http-"));
    await mkdir(join(data, "hermes"), { mode: 0o700 });
    await writeFile(join(data, "config.json"), JSON.stringify({ instances: { ghost: { driver: "not-a-real-driver" } } }), { mode: 0o600 });
    await writeFile(join(data, "service-admin.json"), JSON.stringify({ version: 1, passwordVerifier: await createServiceAdminPasswordVerifier(password) }), { mode: 0o600 });
    fixture = await startCompanyPostgresFixture({ outputDirectory: "outputs/realbud-core-implementation-2026-09-14/http", postgresBinDirectory: process.env.REALBUD_TEST_POSTGRES_BIN || "/opt/homebrew/bin" });
    await startServer();
  }, 40_000);

  afterAll(async () => {
    await stopServer();
    if (companionChild && companionChild.exitCode === null) { const done = once(companionChild, "exit"); companionChild.kill("SIGTERM"); const timer = setTimeout(() => companionChild?.kill("SIGKILL"), 5000); await done; clearTimeout(timer); }
    if (fixture) await fixture.stop();
    if (data) await rm(data, { recursive: true, force: true });
  }, 20_000);

  it("protects administrator/company APIs with ordinary session and separate admin authority", async () => {
    expect((await request("GET", "/api/service-admin/status", undefined, { noAppSession: true })).status).toBe(401);
    const status = await request("GET", "/api/company/status");
    expect(status.body).toMatchObject({ storageAvailable: true, configured: false, setupAllowed: false, transport: "local-only" });
    expect((await request("POST", "/api/company/create", { name: "Synthetic office", ownerName: "Alice", credential: ownerCredential })).status).toBe(401);
    for (const [path, body] of [
      ["/api/hermes/model", { providerId: "custom", apiKey: "must-not-write", model: "override" }],
      ["/api/hermes/oauth/start", { providerId: "openai" }],
      ["/api/connected-apps/mode", { mode: "consumer" }],
    ] as const) expect((await request("POST", path, body)).status).toBe(401);
    expect((await request("PATCH", "/api/config", { xai: { key: "must-not-write" } })).status).toBe(401);
    expect((await request("PATCH", "/api/config", { profile: { name: "Local profile" } })).status).toBe(200);
  });

  it("logs in only this admin session and creates a single host company", async () => {
    const login = await request("POST", "/api/service-admin/login", { password });
    expect(login.status).toBe(200); administrator = login.body.token; oldAdministrator = administrator;
    expect((await request("GET", "/api/service-admin/status")).body.authenticated).toBe(false);
    expect((await request("GET", "/api/service-admin/status", undefined, { admin: administrator })).body.authenticated).toBe(true);
    expect((await request("GET", `/api/service-admin/status?token=${administrator}`)).body.authenticated).toBe(false);
    expect((await request("POST", "/api/company/create", { name: "Incomplete", ownerName: "Alice" }, { admin: administrator })).status).toBe(400);
    const created = await request("POST", "/api/company/create", { name: "Synthetic office", ownerName: "Alice", credential: ownerCredential }, { admin: administrator });
    expect(created.status).toBe(201); owner = created.body.memberToken;
    expect(created.body.recoveryKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await request("POST", "/api/company/sign-in", ownerCredential)).body.member.id).toBe(created.body.member.id);
    expect(created.body.member).toMatchObject({ displayName: "Alice", role: "owner" });
    expect((await request("POST", "/api/company/create", { name: "Duplicate", ownerName: "Wrong", credential: ownerCredential }, { admin: administrator })).status).toBe(409);
    expect((await request("GET", "/api/company/status")).body.company).toBeUndefined();
  });

  it("redeems one-use invitations without inheriting service administration", async () => {
    await startServer(true);
    const invitation = await request("POST", "/api/company/invitations", { displayName: "Bob" }, { member: owner });
    expect(invitation.status).toBe(201);
    expect((await request("POST", "/api/company/join", { invitationToken: invitation.body.invitationToken }, { companion: true })).status).toBe(400);
    const joined = await request("POST", "/api/company/join", { invitationToken: invitation.body.invitationToken, credential: memberCredential }, { companion: true });
    expect(joined.status).toBe(201); member = joined.body.memberToken;
    expect(joined.body.recoveryKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await request("POST", "/api/company/sign-in", memberCredential, { companion: true })).body.member.id).toBe(joined.body.member.id);
    expect(joined.body.member).toMatchObject({ displayName: "Bob", role: "member" });
    expect((await request("POST", "/api/company/join", { invitationToken: invitation.body.invitationToken, credential: memberCredential }, { companion: true })).status).toBe(409);
    expect((await request("POST", "/api/company/invitations", { displayName: "Wrong" }, { member })).status).toBe(403);
    expect((await request("PATCH", "/api/config", { composio: { apiKey: "must-not-write" } }, { member: owner })).status).toBe(401);
  });

  it("enforces private and shared revision access through actual routes", async () => {
    const scopes = (await request("GET", "/api/company/scopes", undefined, { member: owner })).body.scopes;
    privateScope = scopes.find((scope: any) => scope.kind === "private").id;
    companyScope = scopes.find((scope: any) => scope.kind === "company").id;
    expect((await request("PUT", "/api/company/knowledge", { scopeId: privateScope, key: "preference", expectedRevision: "0", content: "Synthetic private preference", sourceRefs: [] }, { member: owner })).status).toBe(200);
    expect([403, 404]).toContain((await request("POST", "/api/company/knowledge/read", { scopeId: privateScope, key: "preference" }, { member })).status);
    const shared = { scopeId: companyScope, key: "procedure", expectedRevision: "0", content: "Synthetic approved procedure", sourceRefs: ["fixture:procedure"] };
    expect((await request("PUT", "/api/company/knowledge", shared, { member: owner })).status).toBe(200);
    expect((await request("POST", "/api/company/knowledge/read", { scopeId: companyScope, key: "procedure" }, { member })).body.knowledge.content).toBe(shared.content);
    expect((await request("PUT", "/api/company/knowledge", shared, { member: owner })).status).toBe(409);
    expect((await request("POST", "/api/company/knowledge/read", { scopeId: companyScope, key: "procedure", memberId: "forged" }, { member })).status).toBe(400);
  });

  it("preserves member sessions across service restart while revoking admin sessions", async () => {
    await stopServer(); await startServer();
    expect((await request("GET", "/api/company/me", undefined, { member: owner })).body.member.displayName).toBe("Alice");
    expect((await request("GET", "/api/company/me", undefined, { member })).body.member.displayName).toBe("Bob");
    expect((await request("GET", "/api/service-admin/status", undefined, { admin: oldAdministrator })).body.authenticated).toBe(false);
  }, 20_000);

  it("does not let service administration impersonate the owner or invalidate their session", async () => {
    expect((await request("POST", "/api/company/recover-owner", {}, { member })).status).toBe(401);
    administrator = (await request("POST", "/api/service-admin/login", { password })).body.token;
    expect((await request("POST", "/api/company/recover-owner", { memberId: "forged" }, { admin: administrator })).status).toBe(400);
    const restored = await request("POST", "/api/company/recover-owner", {}, { admin: administrator });
    expect(restored.status).toBe(409);
    expect(restored.body).toMatchObject({ code: "owner_proof_required" });
    expect(restored.body.memberToken).toBeUndefined();
    expect((await request("GET", "/api/company/status", undefined, { admin: administrator })).body.ownerRecoveryAllowed).toBe(false);
    expect((await request("GET", "/api/company/me", undefined, { member: owner })).status).toBe(200);
    expect((await request("POST", "/api/company/knowledge/read", { scopeId: privateScope, key: "preference" }, { admin: administrator })).status).toBe(401);
    const audit = await fixture.adminPool.query("SELECT count(*)::int AS n FROM realbud_company.audit_events WHERE kind='owner_session_recovered'");
    expect(audit.rows[0].n).toBe(0);
  });

  it("reports damaged shared work as recovery through the full local HTTP boundary", async () => {
    const directory = await request("GET", "/api/company/work-members", undefined, { member: owner });
    const recipient = directory.body.members.find((person: any) => person.displayName === "Bob");
    const created = await request("POST", "/api/company/work", { requestId: randomUUID(), title: "Synthetic recovery review",
      summary: "Keep the original record when damaged.", purpose: "request-review", recipientMemberIds: [recipient.id], assigneeMemberId: recipient.id }, { member: owner });
    expect(created.status).toBe(201);
    const item = created.body.item;
    await fixture.adminPool.query("UPDATE realbud_company.knowledge_revisions SET content='{}' WHERE scope_id=$1 AND key='realbud-work-item:v1'", [item.scopeId]);
    const result = await request("POST", "/api/company/work/list", { offset: 0, filter: "with-me" }, { member });
    expect(result).toMatchObject({ status: 422, body: { code: "recovery_required", error: expect.stringContaining("original record is preserved") } });
    expect((await request("POST", "/api/company/work/respond", { id: item.id, expectedRevision: item.revision, response: "Do not overwrite" }, { member })).status).toBe(422);
    expect((await fixture.adminPool.query("SELECT content FROM realbud_company.knowledge_revisions WHERE scope_id=$1", [item.scopeId])).rows[0].content).toBe("{}");
  });

  it("requires service entitlement for paid work while allowing records and revocation", async () => {
    expect((await request("GET", "/api/service/status")).body).toMatchObject({ state: "unconfigured", capabilities: [] });
    expect((await request("POST", "/api/tts/speak", { text: "Synthetic voice check." }, { noAppSession: true })).status).toBe(401);
    const voice = await request("POST", "/api/tts/speak", { text: "Synthetic voice check." }, { admin: administrator });
    expect(voice.status).toBe(402);
    expect(voice.body.error).toContain("provisioning");
    expect((await request("GET", "/api/company/me", undefined, { member: owner })).status).toBe(200);
    expect((await request("POST", "/api/company/logout", {}, { member })).status).toBe(200);
    expect((await request("POST", "/api/company/logout", {}, { member })).status).toBe(200);
    expect((await request("GET", "/api/company/me", undefined, { member })).status).toBe(401);
    expect((await request("POST", "/api/service-admin/logout", {}, { admin: administrator })).status).toBe(200);
    expect((await request("GET", "/api/service-admin/status", undefined, { admin: administrator })).body.authenticated).toBe(false);
  });
});
