// Who may change approvals, through the real HTTP server on a computer that
// belongs to an office member. No office answers here, so nobody can prove
// they may edit: every route that changes approvals refuses with a plain
// sentence and saves nothing. The read-only member's named refusal and the
// editor's save are covered against a fictional office in
// approval-settings.test.ts and on PostgreSQL in
// company/approval-settings.integration.test.ts.
import { readSessionToken } from "./testing/local-session.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SIGN_IN_TO_CHANGE } from "./approval-settings.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const settings = { version: 1, purpose: "approval-settings", groups: { "app:gmail": "read-without-asking" }, reviewedReads: [] };

describe("approval changes on an office member's computer", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";
  let sessionToken = "";
  const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { "content-type": "application/json", "x-realbud-session": sessionToken, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "omb-approvals-test-"));
    mkdirSync(join(home, ".realbud", "company-installation"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, ".realbud", "config.json"), JSON.stringify({ instances: {} }), { mode: 0o600 });
    // This private workspace already belongs to a (fictional) office member.
    writeFileSync(join(home, ".realbud", "company-installation", "seat.json"),
      JSON.stringify({ version: 1, memberId: "fictional-member-0001", adoptedAt: "2026-10-07T00:00:00.000Z" }), { mode: 0o600 });
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        VITEST: "true",
        HOME: home,
        USERPROFILE: home,
        OMB_PORT: String(PORT),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (chunk) => (stderr += chunk));
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${BASE}/api/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    sessionToken = await readSessionToken(join(home, ".realbud"));
  }, 30_000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (!child || child.exitCode !== null) return resolve();
      child.on("close", () => resolve());
    });
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it("keeps the session token in front of the approval routes", async () => {
    expect((await fetch(`${BASE}/api/approvals`)).status).toBe(401);
    expect((await fetch(`${BASE}/api/approvals`, { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
  });

  it("refuses every approval change it cannot tie to an editor, and saves nothing", async () => {
    const memberSession = { "x-realbud-member-session": "fictional_member_session_000000000000000000" };
    for (const headers of [{}, memberSession]) {
      expect(await api("PUT", "/api/approvals", { expectedRevision: 0, settings }, headers)).toEqual({ status: 403, body: { error: SIGN_IN_TO_CHANGE } });
      expect(await api("POST", "/api/rules", { key: "Bash:git", decision: "allow" }, headers)).toEqual({ status: 403, body: { error: SIGN_IN_TO_CHANGE } });
      expect(await api("POST", "/api/rules", { surface: "portal-read", origin: "portal.fictional-strata.example", decision: "allow" }, headers)).toEqual({ status: 403, body: { error: SIGN_IN_TO_CHANGE } });
      expect(await api("DELETE", "/api/rules/fictional-rule", undefined, headers)).toEqual({ status: 403, body: { error: SIGN_IN_TO_CHANGE } });
      // The bot's own always-allow list is refused for everyone, as before.
      expect((await api("PATCH", "/api/bots/bud", { alwaysAllow: ["Bash:git"] }, headers)).status).toBe(403);
    }
    expect((await api("GET", "/api/rules")).body.rules).toEqual([]);
    expect(await api("GET", "/api/approvals/history")).toEqual({ status: 200, body: { entries: [] } });
    expect(await api("GET", "/api/approvals")).toEqual({ status: 403, body: { error: "Sign in to your office to see approval settings." } });
  });
});
