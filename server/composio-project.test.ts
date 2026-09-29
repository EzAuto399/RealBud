// A local fake Composio. Every test drives the module's real fetch path against
// a 127.0.0.1 server on an ephemeral port, so the assertions are about the
// request that actually left the process — method, path, query, headers — not
// about a mocked fetch.
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMPOSIO_PLATFORM_API, createProject, deleteProject, getProject, listProjects, regenerateProjectKey } from "./composio-project.ts";

const ORG_KEY = "org_fixture_key_0123456789";
// Shaped like a real project key so the module accepts it; the leak test asserts
// this exact value never appears in a thrown message.
const SECRET = "ak_fixture_secret_must_never_be_echoed_0123456789";
const PROJECT = { id: "pr_office_fixture", name: "Fictional Office" };
const livePage = (data: unknown[], currentPage: number, totalPages: number, totalItems: number, nextCursor: string | null = null) =>
  ({ data, current_page: currentPage, total_pages: totalPages, total_items: totalItems, next_cursor: nextCursor });

interface ReceivedRequest {
  method: string;
  path: string;
  search: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

const savedBase = process.env.REALBUD_COMPOSIO_API_BASE;
let server: Server | null = null;
let received: ReceivedRequest[] = [];
let onRequest: (request: ReceivedRequest, response: ServerResponse) => void;

function reply(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(typeof body === "string" ? body : JSON.stringify(body));
}

async function messageOf(work: Promise<unknown>): Promise<string> {
  try { await work; return ""; }
  catch (error) { return error instanceof Error ? error.message : String(error); }
}

beforeEach(async () => {
  received = [];
  onRequest = (_request, response) => reply(response, 200, {});
  const fixture = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const entry: ReceivedRequest = {
        method: request.method ?? "", path: url.pathname, search: url.search,
        headers: request.headers, body: Buffer.concat(chunks).toString("utf8"),
      };
      received.push(entry);
      onRequest(entry, response);
    });
  });
  server = fixture;
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const address = fixture.address() as AddressInfo | null;
  if (!address || typeof address === "string") throw new Error("fixture unavailable");
  process.env.REALBUD_COMPOSIO_API_BASE = `http://127.0.0.1:${address.port}/api/v3.1`;
});

afterEach(async () => {
  if (savedBase === undefined) delete process.env.REALBUD_COMPOSIO_API_BASE;
  else process.env.REALBUD_COMPOSIO_API_BASE = savedBase;
  const fixture = server;
  server = null;
  if (!fixture) return;
  fixture.closeAllConnections();
  await new Promise<void>((resolve) => fixture.close(() => resolve()));
});

describe("createProject", () => {
  it("posts the new project with the organisation key and returns the parsed project", async () => {
    onRequest = (_request, response) => reply(response, 200, { id: PROJECT.id, name: PROJECT.name, api_key: SECRET });
    await expect(createProject(ORG_KEY, PROJECT.name)).resolves.toEqual({ id: PROJECT.id, name: PROJECT.name, apiKey: SECRET });
    expect(received).toHaveLength(1);
    expect(received[0].method).toBe("POST");
    expect(received[0].path).toBe("/api/v3.1/org/owner/project/new");
    expect(received[0].headers["x-org-api-key"]).toBe(ORG_KEY);
    expect(JSON.parse(received[0].body)).toEqual({ name: PROJECT.name, should_create_api_key: true });
  });

  it("rejects a returned key that is not ak_-shaped, without echoing it", async () => {
    const consumerKey = "ck_consumer_key_0123456789";
    onRequest = (_request, response) => reply(response, 200, { id: PROJECT.id, name: PROJECT.name, api_key: consumerKey });
    const message = await messageOf(createProject(ORG_KEY, PROJECT.name));
    expect(message).toMatch(/ak_/);
    expect(message).not.toContain(consumerKey);
  });

  it.each([["missing", undefined], ["empty", ""], ["numeric", 7]] as const)("rejects a create that returned no usable key (%s)", async (_case, apiKey) => {
    onRequest = (_request, response) => reply(response, 200, { id: PROJECT.id, name: PROJECT.name, api_key: apiKey });
    await expect(createProject(ORG_KEY, PROJECT.name)).rejects.toThrow(/ak_/);
  });

  it("rejects an unreadable project id before it can be used later", async () => {
    onRequest = (_request, response) => reply(response, 200, { id: "office_1", name: PROJECT.name, api_key: SECRET });
    await expect(createProject(ORG_KEY, PROJECT.name)).rejects.toThrow(/readable new project/);
  });
});

describe("deleteProject", () => {
  it("sends DELETE with revoke_on_delete=true", async () => {
    onRequest = (_request, response) => reply(response, 200, { status: "success", revoke_job_id: "oj_fixture_1" });
    await deleteProject(ORG_KEY, PROJECT.id);
    expect(received).toHaveLength(1);
    expect(received[0].method).toBe("DELETE");
    expect(received[0].path).toBe(`/api/v3.1/org/owner/project/${PROJECT.id}`);
    expect(received[0].search).toBe("?revoke_on_delete=true");
    expect(received[0].headers["x-org-api-key"]).toBe(ORG_KEY);
  });

  it("returns the revocation job id on a well-formed success", async () => {
    onRequest = (_request, response) => reply(response, 200, { status: "success", revoke_job_id: "oj_fixture_2" });
    await expect(deleteProject(ORG_KEY, PROJECT.id)).resolves.toEqual({ revokeJobId: "oj_fixture_2" });
  });

  it("omits the revoke flag only when the tests-only option asks for it", async () => {
    onRequest = (_request, response) => reply(response, 200, { status: "success", revoke_job_id: "oj_fixture_3" });
    await deleteProject(ORG_KEY, PROJECT.id, { revokeUpstreamCredentials: false });
    expect(received).toHaveLength(1);
    expect(received[0].method).toBe("DELETE");
    expect(received[0].search).toBe("");
  });

  it("fails closed on HTTP 500", async () => {
    onRequest = (_request, response) => reply(response, 500, { message: `could not revoke ${SECRET}` });
    const message = await messageOf(deleteProject(ORG_KEY, PROJECT.id));
    expect(message).toMatch(/NOT confirmed deleted/i);
    expect(received).toHaveLength(1);
  });

  it.each([
    [{ status: "success" }, "no revocation job id"],
    [{ status: "success", revoke_job_id: "" }, "empty revocation job id"],
    [{ status: "success", revoke_job_id: 42 }, "non-string revocation job id"],
    [{ status: "error", revoke_job_id: "oj_fixture_4" }, "non-success status"],
    [{}, "empty body"],
  ])("fails closed when the 200 body is %j (%s)", async (body, _case) => {
    onRequest = (_request, response) => reply(response, 200, body);
    await expect(deleteProject(ORG_KEY, PROJECT.id)).rejects.toThrow(/may still be live|revocation cannot be confirmed/);
  });

  it("fails closed when the body is not JSON", async () => {
    onRequest = (_request, response) => reply(response, 200, "<html>gateway</html>");
    await expect(deleteProject(ORG_KEY, PROJECT.id)).rejects.toThrow(/NOT confirmed deleted/i);
  });

  it("fails closed when the connection drops, and does not retry", async () => {
    onRequest = (_request, response) => response.destroy();
    const message = await messageOf(deleteProject(ORG_KEY, PROJECT.id));
    expect(message).toMatch(/NOT confirmed deleted/i);
    // Exactly one: a retry would show up here as a second request.
    expect(received).toHaveLength(1);
  });

  it("fails closed when Composio is unreachable", async () => {
    // A port that was just released and is therefore closed.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const address = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    process.env.REALBUD_COMPOSIO_API_BASE = `http://127.0.0.1:${address.port}/api/v3.1`;
    await expect(deleteProject(ORG_KEY, PROJECT.id)).rejects.toThrow(/NOT confirmed deleted/i);
  });

  it.each(["", "pr_", "office_1", "pr_office/../../org/owner/project/list", `pr_${"a".repeat(200)}`, SECRET])(
    "refuses a project id that is not pr_-shaped without any request (%j)",
    async (nanoId) => {
      const message = await messageOf(deleteProject(ORG_KEY, nanoId));
      expect(message).toMatch(/not a Composio project id/);
      // The message names the expected shape ("pr_…") on purpose, so only longer
      // rejected values are checked for echoing.
      if (nanoId.length > 3) expect(message).not.toContain(nanoId);
      expect(received).toHaveLength(0);
    },
  );

  it.each(["", "   ", "\n\t "])("refuses an empty organisation key before any request (%j)", async (orgKey) => {
    const message = await messageOf(deleteProject(orgKey, PROJECT.id));
    expect(message).toContain("REALBUD_COMPOSIO_ORG_KEY");
    expect(received).toHaveLength(0);
  });

  it("refuses a base URL that is not an HTTPS endpoint, without any request", async () => {
    process.env.REALBUD_COMPOSIO_API_BASE = "ftp://127.0.0.1/api/v3.1";
    const message = await messageOf(deleteProject(ORG_KEY, PROJECT.id));
    expect(message).toContain("REALBUD_COMPOSIO_API_BASE");
    expect(received).toHaveLength(0);
  });
});

describe("project reads", () => {
  it("regenerates the project key with a POST to the regenerate path", async () => {
    const replacement = "ak_replacement_fixture_0123456789";
    onRequest = (_request, response) => reply(response, 200, { api_key: { id: "key_1", name: "default", key: replacement, created_at: "2026-01-01T00:00:00Z" }, message: "ok" });
    await expect(regenerateProjectKey(ORG_KEY, PROJECT.id)).resolves.toBe(replacement);
    expect(received).toHaveLength(1);
    expect(received[0].method).toBe("POST");
    expect(received[0].path).toBe(`/api/v3.1/org/owner/project/${PROJECT.id}/regenerate_api_key`);
    expect(received[0].headers["x-org-api-key"]).toBe(ORG_KEY);
  });

  it("reads one project and a full project list", async () => {
    onRequest = (_request, response) => reply(response, 200, { id: PROJECT.id, name: PROJECT.name });
    await expect(getProject(ORG_KEY, PROJECT.id)).resolves.toEqual({ id: PROJECT.id, name: PROJECT.name });
    expect(received[0].method).toBe("GET");
    expect(received[0].path).toBe(`/api/v3.1/org/owner/project/${PROJECT.id}`);

    onRequest = (_request, response) => reply(response, 200, livePage([{ id: PROJECT.id, name: PROJECT.name }, { id: "pr_other_fixture", name: "Other Office", api_key: SECRET }], 1, 1, 2));
    await expect(listProjects(ORG_KEY)).resolves.toEqual([{ id: PROJECT.id, name: PROJECT.name }, { id: "pr_other_fixture", name: "Other Office", apiKey: SECRET }]);
    expect(received[1].path).toBe("/api/v3.1/org/owner/project/list");
  });

  it("follows a returned opaque cursor and verifies the full v3.1 list", async () => {
    const cursor = "cGFnZT0yL2xpbWl0PTUw==";
    onRequest = (request, response) => reply(response, 200, request.search
      ? livePage([{ id: "pr_other_fixture", name: "Other Office" }], 2, 2, 2)
      : livePage([PROJECT], 1, 2, 2, cursor));
    await expect(listProjects(ORG_KEY)).resolves.toEqual([PROJECT, { id: "pr_other_fixture", name: "Other Office" }]);
    expect(received).toHaveLength(2);
    expect(received.map(request => request.method)).toEqual(["GET", "GET"]);
    expect(received[1].path).toBe("/api/v3.1/org/owner/project/list");
    expect(new URLSearchParams(received[1].search).get("cursor")).toBe(cursor);
    expect(received[1].headers["x-org-api-key"]).toBe(ORG_KEY);
  });

  it("preserves older unpaginated arrays and follows items cursors", async () => {
    onRequest = (_request, response) => reply(response, 200, [PROJECT]);
    await expect(listProjects(ORG_KEY)).resolves.toEqual([PROJECT]);
    onRequest = (request, response) => reply(response, 200, request.search
      ? { items: [{ id: "pr_other_fixture", name: "Other Office" }], next_cursor: null }
      : { items: [PROJECT], next_cursor: "page2" });
    await expect(listProjects(ORG_KEY)).resolves.toEqual([PROJECT, { id: "pr_other_fixture", name: "Other Office" }]);
  });

  it("fails closed when a v3.1 project list ends before its recorded total", async () => {
    onRequest = (_request, response) => reply(response, 200, livePage([PROJECT], 1, 2, 2));
    await expect(listProjects(ORG_KEY)).rejects.toThrow(/only part of the project list/);
    expect(received).toHaveLength(1);
  });

  it.each([
    ["missing data", { items: null, total_pages: 1, current_page: 1, total_items: 0 }],
    ["missing counts", { data: [PROJECT], next_cursor: null }],
    ["wrong count", livePage([PROJECT], 1, 1, 2)],
    ["malformed cursor", livePage([PROJECT], 1, 2, 2, "bad\nvalue")],
  ])("fails closed on a malformed list page (%s)", async (_case, body) => {
    onRequest = (_request, response) => reply(response, 200, body);
    await expect(listProjects(ORG_KEY)).rejects.toThrow(/could not read|only part of the project list/);
  });

  it("fails closed on duplicate projects and looping cursors", async () => {
    const pages = [livePage([PROJECT], 1, 3, 3, "page2"), livePage([{ id: "pr_other_fixture", name: "Other Office" }], 2, 3, 3, "page2")];
    onRequest = (_request, response) => reply(response, 200, pages[Math.min(received.length - 1, pages.length - 1)]);
    await expect(listProjects(ORG_KEY)).rejects.toThrow(/only part of the project list/);
    expect(received).toHaveLength(2);

    received = [];
    onRequest = (_request, response) => reply(response, 200, received.length === 1
      ? livePage([PROJECT], 1, 2, 2, "page2")
      : livePage([PROJECT], 2, 2, 2));
    await expect(listProjects(ORG_KEY)).rejects.toThrow(/only part of the project list/);
    expect(received).toHaveLength(2);
  });
});

describe("secrets", () => {
  it("keeps the documented Platform base as the default", () => {
    expect(COMPOSIO_PLATFORM_API).toBe("https://backend.composio.dev/api/v3.1");
  });

  it("never puts a key or a provider body into an error message", async () => {
    const messages: string[] = [];
    // A 4xx body, a success body and a 5xx body can all quote the key that was
    // sent; none of it may reach an operator, a log or an audit artifact.
    onRequest = (_request, response) => reply(response, 401, { message: `invalid key ${SECRET}`, api_key: SECRET });
    messages.push(await messageOf(createProject(ORG_KEY, PROJECT.name)));
    onRequest = (_request, response) => reply(response, 200, { id: "office_1", name: PROJECT.name, api_key: SECRET });
    messages.push(await messageOf(createProject(ORG_KEY, PROJECT.name)));
    onRequest = (_request, response) => reply(response, 200, { message: `rotated ${SECRET}`, api_key: null });
    messages.push(await messageOf(regenerateProjectKey(ORG_KEY, PROJECT.id)));
    onRequest = (_request, response) => reply(response, 200, { id: PROJECT.id, name: PROJECT.name, api_key: `ck_${SECRET}` });
    messages.push(await messageOf(getProject(ORG_KEY, PROJECT.id)));
    onRequest = (_request, response) => reply(response, 500, { message: `could not revoke ${SECRET}` });
    messages.push(await messageOf(deleteProject(ORG_KEY, PROJECT.id)));
    for (const message of messages) {
      expect(message).not.toBe("");
      expect(message).not.toContain(SECRET);
      expect(message).not.toContain(ORG_KEY);
    }
  });
});
