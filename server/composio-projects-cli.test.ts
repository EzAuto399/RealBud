// Drives the real operator CLI as a child process against a fake Composio.
//
// The gates below are the point: `decommission` revokes an office's upstream
// OAuth grants and cannot be undone, so a refactor that quietly drops
// --confirm or --revoke-upstream must fail here rather than in production.

import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = resolve(ROOT, "scripts/manage-composio-projects.mjs");
const ORG_KEY = "org_test_key_do_not_log";
const SECRET_KEY = "ak_secretvalue123456";

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

let server: Server;
let base = "";
let seen: Seen[] = [];
let deleteStatus = 200;
let deleteBody: unknown = { status: "success", revoke_job_id: "oj_test_1" };

function run(args: string[], env: Record<string, string> = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((settle, fail) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", CLI, ...args], {
      cwd: ROOT,
      env: {
        ...process.env,
        REALBUD_COMPOSIO_ORG_KEY: ORG_KEY,
        REALBUD_COMPOSIO_API_BASE: base,
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", fail);
    child.on("close", (code) => settle({ code: code ?? -1, stdout, stderr }));
  });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => {
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      const url = req.url ?? "";
      res.setHeader("content-type", "application/json");
      if (req.method === "DELETE") {
        res.statusCode = deleteStatus;
        res.end(JSON.stringify(deleteBody));
        return;
      }
      if (url.includes("/regenerate_api_key")) {
        res.end(JSON.stringify({ api_key: { id: "01H", name: "k", key: SECRET_KEY, created_at: "2026-01-01T00:00:00.000Z" }, message: "API key regenerated successfully" }));
        return;
      }
      if (url.endsWith("/project/new")) {
        res.end(JSON.stringify({ id: "pr_newone", name: "Harbour PM", api_key: SECRET_KEY }));
        return;
      }
      if (url.endsWith("/project/list")) {
        res.end(JSON.stringify([{ id: "pr_listed", name: "Listed Office" }]));
        return;
      }
      res.end(JSON.stringify({ id: "pr_shown", name: "Shown Office" }));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  base = `http://127.0.0.1:${address.port}/api/v3.1`;
});

afterAll(() => { server.close(); });
afterEach(() => {
  seen = [];
  deleteStatus = 200;
  deleteBody = { status: "success", revoke_job_id: "oj_test_1" };
});

describe("manage-composio-projects", () => {
  it("refuses to decommission without --confirm", async () => {
    const result = await run(["decommission", "--project", "pr_abc", "--revoke-upstream"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/--confirm/);
    expect(seen).toHaveLength(0);
  });

  it("refuses to decommission without --revoke-upstream", async () => {
    // Deleting without revoking leaves the office's OAuth grants live, which is
    // not an offboarding. The tool must not allow that by default.
    const result = await run(["decommission", "--project", "pr_abc", "--confirm"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/--revoke-upstream/);
    expect(seen).toHaveLength(0);
  });

  it("decommissions with the revoke flag and reports the job", async () => {
    const result = await run(["decommission", "--project", "pr_abc", "--confirm", "--revoke-upstream"]);
    expect(result.code).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe("DELETE");
    expect(seen[0]!.url).toContain("/org/owner/project/pr_abc");
    expect(seen[0]!.url).toContain("revoke_on_delete=true");
    expect(seen[0]!.headers["x-org-api-key"]).toBe(ORG_KEY);
    expect(result.stdout).toContain("oj_test_1");
  });

  it("fails loudly when Composio does not confirm the deletion", async () => {
    deleteStatus = 500;
    deleteBody = { error: "boom" };
    const result = await run(["decommission", "--project", "pr_abc", "--confirm", "--revoke-upstream"]);
    expect(result.code).toBe(1);
    expect(result.stdout).not.toMatch(/Decommissioned/);
  });

  it("still fails when the response omits the revocation job", async () => {
    deleteBody = { status: "success" };
    const result = await run(["decommission", "--project", "pr_abc", "--confirm", "--revoke-upstream"]);
    expect(result.code).toBe(1);
    expect(result.stdout).not.toMatch(/Decommissioned/);
  });

  it("provisions a project and prints the key exactly once", async () => {
    const result = await run(["provision", "--name", "Harbour PM"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("pr_newone");
    expect(result.stdout.split(SECRET_KEY)).toHaveLength(2);
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.body).toContain("Harbour PM");
  });

  it("requires --name for provision", async () => {
    const result = await run(["provision"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/--name/);
    expect(seen).toHaveLength(0);
  });

  it("requires --confirm to rotate a key", async () => {
    const result = await run(["rotate", "--project", "pr_abc"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/--confirm/);
    expect(seen).toHaveLength(0);
  });

  it("rotates with --confirm", async () => {
    const result = await run(["rotate", "--project", "pr_abc", "--confirm"]);
    expect(result.code).toBe(0);
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url).toContain("/regenerate_api_key");
    expect(result.stdout).toContain(SECRET_KEY);
  });

  it("lists projects without printing any key", async () => {
    const result = await run(["list"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("pr_listed");
    expect(result.stdout).not.toContain(SECRET_KEY);
    expect(result.stdout).not.toContain("ak_");
  });

  it("refuses to run without the organisation key", async () => {
    const result = await run(["list"], { REALBUD_COMPOSIO_ORG_KEY: "" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("REALBUD_COMPOSIO_ORG_KEY");
    expect(seen).toHaveLength(0);
  });

  it("rejects a malformed project id before reaching the network", async () => {
    const result = await run(["decommission", "--project", "ak_notaproject", "--confirm", "--revoke-upstream"]);
    expect(result.code).toBe(1);
    expect(seen).toHaveLength(0);
  });

  it("never prints the organisation key", async () => {
    for (const args of [["list"], ["show", "--project", "pr_shown"], ["provision", "--name", "X"]]) {
      const result = await run(args);
      expect(result.stdout).not.toContain(ORG_KEY);
      expect(result.stderr).not.toContain(ORG_KEY);
    }
  });

  it("rejects unknown commands", async () => {
    const result = await run(["destroy-everything"]);
    expect(result.code).toBe(1);
    expect(seen).toHaveLength(0);
  });
});
