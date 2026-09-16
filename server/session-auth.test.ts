import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { needsSession, sessionOk, SESSION_TOKEN } from "./session-auth.ts";

describe("Ask mutation session boundary", () => {
  it.each([
    ["POST", "/api/bots/bud/messages"],
    ["PUT", "/api/bots/bud/queued-message"],
    ["DELETE", "/api/bots/bud/queued-message"],
    ["POST", "/api/bots/bud/steer"],
    ["POST", "/api/bots/bud/interrupt"],
    ["POST", "/api/bots/bud/respond"],
    ["POST", "/api/threads/thread-1/respond"],
    ["POST", "/api/bots/bud/messages/message-1/edit"],
    ["POST", "/api/bots/bud/active-branch"],
    ["POST", "/api/bots/bud/tasks"],
    ["PATCH", "/api/bots/bud/tasks/task-1"],
    ["PATCH", "/api/bots/bud"],
    ["POST", "/api/bots"],
    ["POST", "/api/instances/hermes/setup"],
    ["POST", "/api/hermes/update"],
    ["POST", "/api/hermes/update/restore"],
    ["POST", "/api/hermes/install"],
    ["POST", "/api/hermes/repair"],
    ["POST", "/api/hermes/model"],
    ["POST", "/api/hermes/oauth/start"],
  ])("requires the session before %s %s can change work or authority", (method, path) => {
    expect(needsSession(path, method)).toBe(true);
    const req = { url: path, method, headers: { host: "127.0.0.1:8799" } } as unknown as IncomingMessage;
    expect(sessionOk(req, 8799)).toEqual({ ok: false, status: 401, error: "session required" });
    req.headers["x-realbud-session"] = SESSION_TOKEN;
    expect(sessionOk(req, 8799)).toEqual({ ok: true });
  });

  it("rejects the wrong session or origin even with otherwise valid Ask input", () => {
    const req = { url: "/api/bots/bud/messages", method: "POST", headers: {
      host: "127.0.0.1:8799", "x-realbud-session": "wrong-session",
    } } as unknown as IncomingMessage;
    expect(sessionOk(req, 8799)).toMatchObject({ ok: false, status: 401 });
    req.headers["x-realbud-session"] = SESSION_TOKEN;
    req.headers.origin = "https://untrusted.example";
    expect(sessionOk(req, 8799)).toMatchObject({ ok: false, status: 403 });
  });

  it("preserves existing read-only task views, public health, and internal token routes", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      for (const path of ["/api/bots", "/api/bots/bud", "/api/bots/bud/tasks", "/api/threads/thread-1"]) {
        expect(needsSession(path, method)).toBe(false);
      }
    }
    expect(needsSession("/api/bots")).toBe(false);
    expect(needsSession("/api/health", "GET")).toBe(false);
    expect(needsSession("/api/session", "GET")).toBe(false);
    expect(needsSession("/api/internal/ask-bot", "POST")).toBe(false);
    expect(needsSession("/api/bots-lookalike", "POST")).toBe(false);
  });

  it("keeps connection settings and observations protected independently of method", () => {
    for (const path of ["/api/config", "/api/connected-apps/status", "/api/connected-apps/mode", "/api/connected-apps/gmail-readonly/setup"]) {
      expect(needsSession(path)).toBe(true);
      expect(needsSession(path, "GET")).toBe(true);
      expect(needsSession(path, "POST")).toBe(true);
    }
  });
});


it.each([
  ["GET", "/api/workflow-packs"], ["GET", "/api/workflow-packs/export"],
  ["POST", "/api/workflow-packs/import"], ["POST", "/api/workflow-packs/austin-phase-1/install"],
  ["POST", "/api/workflow-packs/austin-expected-bills/install"],
  ["GET", "/api/expected-bills"], ["POST", "/api/expected-bills"],
])("protects office pack and bill data: %s %s", (method, path) => {
  expect(needsSession(path, method)).toBe(true);
  const req = { url: path, method, headers: { host: "127.0.0.1:8799" } } as unknown as IncomingMessage;
  expect(sessionOk(req, 8799)).toMatchObject({ ok: false, status: 401 });
  req.headers["x-realbud-session"] = SESSION_TOKEN;
  expect(sessionOk(req, 8799)).toEqual({ ok: true });
});
