import { describe, expect, it } from "vitest";
import type { Message } from "@/state/store";
import type { ConnectedAppsStatus, ConnectedService } from "@shared/office-sources";
import { deriveAskAppContext } from "./ask-app-context";
import type { ConnectedAppOperation } from "./connected-apps";

const now = Date.parse("2026-10-01T05:00:00.000Z");
const service = (patch: Partial<ConnectedService> = {}): ConnectedService => ({ connected: true, status: "ACTIVE", accounts: [{ id: "office-account", status: "ACTIVE" }], accountSelectionRequired: false, ...patch });
const snapshot = (patch: Partial<ConnectedAppsStatus> = {}): ConnectedAppsStatus => ({ configured: true, checkedAt: new Date(now).toISOString(), services: { gmail: service(), googledrive: service() }, tools: { available: true, names: ["GMAIL_LIST_THREADS", "GOOGLEDRIVE_FIND_FILE"] }, ...patch });
const user = (text: string, id = "request-1"): Message => ({ id, role: "user", kind: "text", text, at: now });
const bot = (text: string): Message => ({ id: "reply-1", role: "bot", kind: "text", text, at: now });
const activity = (name: string, ok?: boolean): Message => ({ id: `tool-${name}`, role: "bot", kind: "activity", tool: { name, ok }, at: now });
const operation = (patch: Partial<ConnectedAppOperation> = {}): ConnectedAppOperation => ({ id: "app-operation-1", threadId: "thread-1", toolName: "COMPOSIO_MULTI_EXECUTE_TOOL", toolSlugs: ["GMAIL_LIST_THREADS"], status: "started", startedAt: new Date(now).toISOString(), ...patch });
const derive = (messages: Message[], access = snapshot(), extra: Partial<Parameters<typeof deriveAskAppContext>[0]> = {}) => deriveAskAppContext({ messages, snapshot: access, now, ...extra });

describe("Ask app context", () => {
  it("keeps known apps browsable without surfacing unrelated connections", () => {
    const context = derive([user("Summarise this attachment")]);
    expect(context.apps.map(app => app.slug)).toEqual(["gmail", "googledrive"]);
    expect(context.availableCount).toBe(2);
    expect(context.relevantApps).toEqual([]);
    expect(context.contextKey).toBe("");
    expect(context.shouldAutoOpen).toBe(false);
  });

  it("matches explicit app names and aliases in the latest request", () => {
    const context = derive([user("Find the owner email in Google Mail and check Google-Drive")]);
    expect(context.relevantApps.map(app => [app.slug, app.reasonLabel])).toEqual([
      ["gmail", "Mentioned in this request"], ["googledrive", "Mentioned in this request"],
    ]);
    expect(context.relevantApps.every(app => app.state === "ready" && app.statusLabel === "Available")).toBe(true);
    expect(context.shouldAutoOpen).toBe(false);
  });

  it.each(["Use Gmail to draft an owner update", "Create a local reminder. Do not use Gmail, calendar, browser or any external account."])("keeps mentioned apps browsable without opening context: %s", text => {
    const context = derive([user(text)]);
    expect(context.relevantApps).toEqual([expect.objectContaining({ slug: "gmail", reason: "request" })]);
    expect(context.apps.map(app => app.slug)).toEqual(["gmail", "googledrive"]);
    expect(context.availableCount).toBe(2);
    expect(context.shouldAutoOpen).toBe(false);
  });

  it("opens context for observed activity even when a request also mentions the app", () => {
    const request = user("Check Gmail");
    expect(derive([request, activity("GMAIL_LIST_THREADS")]).shouldAutoOpen).toBe(true);
    expect(derive([request], snapshot(), { threadId: "thread-1", operations: [operation()] }).shouldAutoOpen).toBe(true);
    for (const receipt of [operation({ status: "denied" }), operation({ threadId: "other-thread" }), operation({ startedAt: new Date(now - 1).toISOString() })]) {
      expect(derive([request], snapshot(), { threadId: "thread-1", operations: [receipt] }).shouldAutoOpen).toBe(false);
    }
  });

  it("does not guess an app from generic terms or partial words", () => {
    for (const text of ["Check the email inbox and files", "notgmail", "mygoogledrivecopy", "Gmailish", "αGmailβ"]) {
      expect(derive([user(text)]).relevantApps).toEqual([]);
    }
  });

  it("uses only the latest user request, without keeping the previous task's app context", () => {
    const context = derive([user("Check Gmail", "old-request"), activity("GMAIL_LIST_THREADS", true), user("Draft a property description", "new-request")]);
    expect(context.relevantApps).toEqual([]);
    expect(context.shouldAutoOpen).toBe(false);
  });

  it("never treats assistant prose or generic dispatcher activity as proof of app use", () => {
    const context = derive([user("Review the owner correspondence"), bot("I used Gmail and Google Drive"), activity("COMPOSIO_MULTI_EXECUTE_TOOL", true), {
      ...activity("generic_read", true), text: "GMAIL_LIST_THREADS", tool: { name: "generic_read", spoken: "Reading Gmail" },
    }]);
    expect(context.relevantApps).toEqual([]);
  });

  it("identifies structured app tool activity including namespaced names without claiming success", () => {
    for (const name of ["GMAIL_LIST_THREADS", "mcp__composio__GMAIL_LIST_THREADS", "gmail.fetch_threads"]) {
      const context = derive([user("Review the correspondence"), activity(name, false)]);
      expect(context.relevantApps).toEqual([expect.objectContaining({ slug: "gmail", reason: "activity", reasonLabel: "App activity in this request" })]);
      expect(context.relevantApps[0].reasonLabel).not.toMatch(/success|used|read|result/i);
      expect(context.shouldAutoOpen).toBe(true);
    }
  });

  it("identifies apps from current-request receipts behind a generic dispatcher", () => {
    const context = derive([user("Review the owner correspondence"), activity("COMPOSIO_MULTI_EXECUTE_TOOL")], snapshot(), {
      threadId: "thread-1", operations: [operation({ toolSlugs: ["GMAIL_LIST_THREADS", "GOOGLEDRIVE_FIND_FILE"] })],
    });
    expect(context.relevantApps.map(app => [app.slug, app.reasonLabel])).toEqual([
      ["gmail", "App activity in this request"], ["googledrive", "App activity in this request"],
    ]);
  });

  it("excludes receipt activity from other chats or before the latest request", () => {
    const context = derive([user("Check earlier correspondence", "old-request"), { ...user("Review the current correspondence"), at: now + 1_000 }], snapshot(), {
      threadId: "thread-1", operations: [
        operation(),
        operation({ threadId: "thread-other", startedAt: new Date(now + 2_000).toISOString(), toolSlugs: ["GOOGLEDRIVE_FIND_FILE"] }),
      ],
    });
    expect(context.relevantApps).toEqual([]);
  });

  it("requires a known thread and valid request and receipt timestamps for receipt relevance", () => {
    const request = user("Review the owner correspondence");
    const receipts = { threadId: "thread-1", operations: [operation()] };
    expect(derive([], snapshot(), receipts).relevantApps).toEqual([]);
    expect(derive([request], snapshot(), { operations: [operation()] }).relevantApps).toEqual([]);
    for (const at of [Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_VALUE]) {
      expect(derive([{ ...request, at }], snapshot(), receipts).relevantApps).toEqual([]);
    }
    expect(derive([request], snapshot(), { ...receipts, operations: [operation({ startedAt: "invalid" })] }).relevantApps).toEqual([]);
  });

  it("omits denied receipts and describes unknown or failed outcomes only as activity", () => {
    const request = user("Review the owner correspondence");
    expect(derive([request], snapshot(), { threadId: "thread-1", operations: [operation({ status: "denied" })] }).relevantApps).toEqual([]);
    for (const status of ["started", "succeeded", "failed", "unknown"] as const) {
      const context = derive([request], snapshot({ excludedApps: ["gmail"] }), { threadId: "thread-1", operations: [operation({ status })] });
      expect(context.relevantApps).toEqual([expect.objectContaining({ slug: "gmail", state: "excluded", statusLabel: "Not available in Ask", reasonLabel: "App activity in this request" })]);
    }
  });

  it("does not infer receipt apps from a dispatcher's name, details, or unknown tool prefixes", () => {
    const context = derive([user("Review the owner correspondence")], snapshot(), {
      threadId: "thread-1", operations: [operation({ toolName: "GMAIL_LIST_THREADS", detail: "Google Drive", toolSlugs: ["COMPOSIO_MULTI_EXECUTE_TOOL", "NOTGMAIL_LIST_THREADS", "NOTION_SEARCH"] })],
    });
    expect(context.relevantApps).toEqual([]);
  });

  it("keeps a receipt's context key stable as its outcome and operation list update", () => {
    const request = user("Review the owner correspondence");
    const before = derive([request], snapshot(), { threadId: "thread-1", operations: [operation()] });
    const after = derive([request], snapshot(), { threadId: "thread-1", operations: [
      operation({ status: "unknown", finishedAt: new Date(now + 1_000).toISOString() }),
      operation({ id: "app-operation-2", startedAt: new Date(now + 2_000).toISOString(), toolSlugs: ["GMAIL_GET_PROFILE"], status: "succeeded" }),
    ] });
    expect(after.contextKey).toBe(before.contextKey);
  });

  it("does not infer unavailable or unknown apps merely from names in conversation", () => {
    const access = snapshot({ services: { gmail: service(), slack: service({ connected: false, status: "DISCONNECTED", accounts: [] }) } });
    const context = derive([user("Read Slack and Notion"), activity("NOTION_SEARCH", true)], access);
    expect(context.apps.map(app => app.slug)).toEqual(["gmail"]);
    expect(context.relevantApps).toEqual([]);
  });

  it("surfaces an explicit pending sign-in before a connection response arrives", () => {
    const context = deriveAskAppContext({ messages: [], snapshot: null, pendingService: "outlook", now });
    expect(context.availableCount).toBe(0);
    expect(context.relevantApps).toEqual([expect.objectContaining({ slug: "outlook", state: "signing-in", reason: "sign-in", reasonLabel: "Finish sign-in" })]);
    expect(context.shouldAutoOpen).toBe(true);
  });

  it("keeps expired accounts reachable, showing recovery only when relevant", () => {
    const access = snapshot({ services: { gmail: service({ connected: false, status: "EXPIRED", accounts: [] }), googledrive: service() } });
    expect(derive([user("Write an advert")], access).relevantApps).toEqual([]);
    const context = derive([user("Check Gmail")], access);
    expect(context.relevantApps).toEqual([expect.objectContaining({ slug: "gmail", state: "degraded", statusLabel: "Needs attention" })]);
    expect(context.availableCount).toBe(1);
  });

  it("does not label unchecked, excluded, ambiguous or failed connections as available", () => {
    const cases: [ConnectedAppsStatus, string][] = [
      [snapshot({ checkedAt: new Date(now - 600_000).toISOString() }), "unchecked"],
      [snapshot({ excludedApps: ["gmail", "googledrive"] }), "excluded"],
      [snapshot({ services: { gmail: service({ accountSelectionRequired: true }) } }), "choose-account"],
      [snapshot({ services: { gmail: service({ accounts: [] }) } }), "degraded"],
      [snapshot({ tools: { available: false, names: [] } }), "degraded"],
      [snapshot({ error: "Cannot check access" }), "degraded"],
      [snapshot({ configured: false }), "setup"],
    ];
    for (const [access, state] of cases) {
      const context = derive([user("Check Gmail")], access);
      expect(context.availableCount).toBe(0);
      expect(context.relevantApps[0].state).toBe(state);
      expect(context.relevantApps[0].statusLabel).not.toBe("Available");
    }
  });

  it("honours a failed current check even when an older snapshot looked ready", () => {
    const context = derive([user("Check Gmail")], snapshot(), { error: "Connection check failed" });
    expect(context.availableCount).toBe(0);
    expect(context.relevantApps[0].state).toBe("degraded");
  });

  it("keeps dismissals stable across timestamp refreshes, reply streaming and repeated tool activity", () => {
    const messages = [user("Check Gmail")];
    const before = derive(messages);
    const after = derive([...messages, bot("Working on Gmail"), activity("GMAIL_LIST_THREADS"), activity("GMAIL_GET_PROFILE", true)], snapshot({ checkedAt: new Date(now + 50_000).toISOString() }), { now: now + 50_000 });
    const stale = derive(messages, snapshot(), { now: now + 600_000 });
    expect(after.contextKey).toBe(before.contextKey);
    expect(stale.contextKey).toBe(before.contextKey);
  });

  it("provides a new context key for a new request or another relevant app", () => {
    const base = derive([user("Check Gmail")]);
    expect(derive([user("Check Gmail", "request-2")]).contextKey).not.toBe(base.contextKey);
    expect(derive([user("Check Gmail"), activity("GOOGLEDRIVE_FIND_FILE")]).contextKey).not.toBe(base.contextKey);
    expect(derive([user("Check Gmail")], snapshot(), { pendingService: "outlook" }).contextKey).not.toBe(base.contextKey);
  });

  it("preserves dismissal through sign-in completion, recovery and failed checks in the same request", () => {
    const base = derive([user("Check Gmail")]);
    expect(derive([user("Check Gmail")], snapshot(), { pendingService: "gmail" }).contextKey).toBe(base.contextKey);
    expect(derive([user("Check Gmail")], snapshot(), { error: "Check failed" }).contextKey).toBe(base.contextKey);
    expect(derive([user("Check Gmail")], snapshot({ services: { gmail: service({ accountSelectionRequired: true }), googledrive: service() } })).contextKey).toBe(base.contextKey);
  });
});
