import { describe, expect, it } from "vitest";
import { classifyAppTool, MAIL_READS, MAIL_SENDS } from "./app-tool-policy.ts";
import { decide, defaultApprovalSettings, normalizeApprovalSettings, PER_INSTANCE_CLASSES, READ_ONLY_APP_TOOLS, uncheckedOfficeSettings, type ApprovalChoice, type ApprovalSettings } from "./approval-settings.ts";

const settings = (groups: Record<string, ApprovalChoice> = {}, reviewedReads: string[] = []): ApprovalSettings =>
  ({ version: 1, purpose: "approval-settings", groups, reviewedReads });

describe("the read-only allowlist", () => {
  // Tokens that change something: sending, deleting, uploading or attaching,
  // labelling or moving, drafting, and any other edit.
  const WRITES = new Set(["SEND", "REPLY", "FORWARD", "DELETE", "REMOVE", "TRASH", "UNTRASH", "SPAM", "UPLOAD", "ADD", "ATTACH", "MODIFY",
    "CREATE", "UPDATE", "PATCH", "INSERT", "IMPORT", "MOVE", "COPY", "MARK", "SET", "ARCHIVE", "BATCH", "CANCEL", "DECLINE", "ACCEPT", "PUT", "POST"]);
  it.each([...READ_ONLY_APP_TOOLS])("%s only reads", tool => {
    expect(tool.split("_").filter(token => WRITES.has(token))).toEqual([]);
    expect(MAIL_SENDS.has(tool)).toBe(false);
    expect(classifyAppTool(tool)).toBe("read");
    if (/^(GMAIL|OUTLOOK)_/.test(tool) && tool !== "OUTLOOK_GET_SCHEDULE") expect(MAIL_READS.has(tool)).toBe(true);
  });
  it("leaves out the managed 'reads' that change mail", () => {
    for (const tool of ["GMAIL_CREATE_EMAIL_DRAFT", "GMAIL_UPDATE_DRAFT", "GMAIL_DELETE_DRAFT", "GMAIL_ADD_LABEL_TO_EMAIL", "GMAIL_MODIFY_THREAD_LABELS",
      "GMAIL_BATCH_MODIFY_MESSAGES", "GMAIL_UNTRASH_MESSAGE", "OUTLOOK_ADD_MAIL_ATTACHMENT", "OUTLOOK_CREATE_MESSAGE_ATTACHMENT", "OUTLOOK_UPDATE_EMAIL", "OUTLOOK_CREATE_DRAFT"]) {
      expect(classifyAppTool(tool)).toBe("read");
      expect(READ_ONLY_APP_TOOLS.has(tool)).toBe(false);
    }
  });
});

describe("normalizeApprovalSettings", () => {
  it("accepts the three choices for apps, websites and connectors, sorted", () => {
    const value = normalizeApprovalSettings(settings({ "site:portal.fictional-strata.example": "ask", "app:gmail": "read-without-asking", "connector:redbark": "deny", "class:send": "deny" }, ["GMAIL_LIST_THREADS", "GMAIL_FETCH_EMAILS"]));
    expect(Object.keys(value.groups)).toEqual(["app:gmail", "class:send", "connector:redbark", "site:portal.fictional-strata.example"]);
    expect(value.reviewedReads).toEqual(["GMAIL_FETCH_EMAILS", "GMAIL_LIST_THREADS"]);
    expect(normalizeApprovalSettings(defaultApprovalSettings())).toEqual(defaultApprovalSettings());
  });
  it.each(PER_INSTANCE_CLASSES)("refuses read without asking for the per-instance class %s", name => {
    expect(() => normalizeApprovalSettings(settings({ [`class:${name}`]: "read-without-asking" }))).toThrow(/always asks before it sends/);
    expect(normalizeApprovalSettings(settings({ [`class:${name}`]: "ask" })).groups[`class:${name}`]).toBe("ask");
  });
  it("refuses a per-instance or changing tool as a reviewed read", () => {
    for (const tool of ["GMAIL_SEND_EMAIL", "GMAIL_MOVE_TO_TRASH", "GMAIL_DELETE_DRAFT", "OUTLOOK_ADD_MAIL_ATTACHMENT", "GMAIL_ADD_LABEL_TO_EMAIL", "XERO_GET_INVOICES"]) {
      expect(() => normalizeApprovalSettings(settings({}, [tool]))).toThrow("Only tools that only read can be marked as reviewed.");
    }
    expect(() => normalizeApprovalSettings(settings({}, ["GMAIL_FETCH_EMAILS", "GMAIL_FETCH_EMAILS"]))).toThrow("reviewed");
  });
  it("refuses unknown keys, groups and choices", () => {
    expect(() => normalizeApprovalSettings({ ...settings(), extra: 1 })).toThrow("not in a form");
    expect(() => normalizeApprovalSettings({ ...settings(), version: 2 })).toThrow("not in a form");
    for (const key of ["gmail", "app:", "app:Gmail", "site:localhost", "site:https://portal.example", "connector:X", "class:read", "tool:GMAIL_SEND_EMAIL", "__proto__"]) {
      expect(() => normalizeApprovalSettings(settings({ [key]: "ask" })), key).toThrow();
    }
    expect(() => normalizeApprovalSettings(settings({ "app:gmail": "allow" as ApprovalChoice }))).toThrow("Choose Read without asking");
  });
  it("refuses more than 200 entries or 16 KiB", () => {
    const many = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`app:tool${i}`, "ask" as const]));
    expect(() => normalizeApprovalSettings(settings(many))).toThrow("too large");
    expect(Object.keys(normalizeApprovalSettings(settings(Object.fromEntries(Object.entries(many).slice(0, 200)))).groups)).toHaveLength(200);
    const long = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`site:${"a".repeat(200)}${i}.example`, "ask" as const]));
    expect(() => normalizeApprovalSettings(settings(long))).toThrow("too large");
  });
});

describe("decide", () => {
  const read = { group: "app:gmail", tool: "GMAIL_FETCH_EMAILS", args: { query: "from:fictional@example.test" }, cls: "read" as const };
  it("keeps today's defaults: managed reads run, direct connections and websites ask", () => {
    expect(decide([], read)).toBe("run");
    expect(decide([], { ...read, direct: true })).toBe("card");
    expect(decide([], { group: "site:portal.fictional-strata.example", tool: "browser_read", cls: "read" })).toBe("card");
    expect(decide([], { group: "connector:redbark", tool: "list_accounts", args: {}, cls: "read" })).toBe("run");
  });
  it("passes a managed group's class through unchanged: drafts and labels still run (owner decision 2 Oct)", () => {
    for (const choice of [undefined, "read-without-asking"] as const) {
      const list = choice ? [settings({ "app:gmail": choice })] : [];
      expect(decide(list, { ...read, tool: "GMAIL_CREATE_EMAIL_DRAFT" })).toBe("run");
      expect(decide(list, { ...read, tool: "GMAIL_ADD_LABEL_TO_EMAIL", args: { add_label_ids: ["STARRED"] } })).toBe("run");
      expect(decide(list, { group: "app:xero", tool: "XERO_GET_INVOICES", args: {}, cls: "read" })).toBe("run");
      expect(decide(list, { ...read, cls: "write" })).toBe("card");
    }
    // Ask and Don't use only make it stricter.
    expect(decide([settings({ "app:gmail": "ask" })], { ...read, tool: "GMAIL_CREATE_EMAIL_DRAFT" })).toBe("card");
    expect(decide([settings({ "app:gmail": "deny" })], { ...read, tool: "GMAIL_CREATE_EMAIL_DRAFT" })).toBe("refuse");
  });
  it("widens past today only for exact allowlisted reads whose arguments pass", () => {
    const direct = { ...read, direct: true }, open = settings({ "app:gmail": "read-without-asking", "app:outlook": "read-without-asking" }, ["GMAIL_FETCH_EMAILS", "GMAIL_LIST_THREADS"]);
    expect(decide([open], direct)).toBe("run");
    expect(decide([open], { ...direct, args: ["not", "an", "object"] })).toBe("card");
    expect(decide([open], { ...direct, group: "app:outlook" })).toBe("card");
    expect(decide([open], { ...direct, tool: "GMAIL_CREATE_EMAIL_DRAFT" })).toBe("card");
    const site = settings({ "site:portal.fictional-strata.example": "read-without-asking" });
    expect(decide([site], { group: "site:portal.fictional-strata.example", tool: "browser_read", cls: "read" })).toBe("run");
    expect(decide([site], { group: "site:portal.fictional-strata.example", tool: "browser_navigate", args: { url: "https://app.portal.fictional-strata.example/ledger" }, cls: "read" })).toBe("run");
    expect(decide([site], { group: "site:portal.fictional-strata.example", tool: "browser_navigate", args: { url: "https://elsewhere.example/" }, cls: "read" })).toBe("card");
    expect(decide([site], { group: "site:portal.fictional-strata.example", tool: "browser_download", cls: "read" })).toBe("card");
  });
  it("refuses blocked calls and unknown groups whatever the settings say", () => {
    expect(decide([settings({ "app:gmail": "read-without-asking" })], { ...read, cls: "blocked" })).toBe("refuse");
    expect(decide([], { ...read, group: "gmail" })).toBe("refuse");
    expect(decide([], { ...read, group: "class:send" })).toBe("refuse");
  });
  it("cards every per-instance class, and refuses it when either its group or its class row is Don't use", () => {
    for (const cls of PER_INSTANCE_CLASSES) {
      expect(decide([settings({ "app:gmail": "read-without-asking" })], { ...read, cls })).toBe("card");
      expect(decide([settings({ "app:gmail": "deny" })], { ...read, cls })).toBe("refuse");
      expect(decide([settings({ [`class:${cls}`]: "deny" })], { ...read, cls })).toBe("refuse");
    }
  });
  it("resolves each department, then merges strictest first: deny beats ask beats read without asking", () => {
    const open = settings({ "app:gmail": "read-without-asking" }), asks = settings({ "app:gmail": "ask" }), denies = settings({ "app:gmail": "deny" });
    expect(decide([open], read)).toBe("run");
    expect(decide([open, asks], read)).toBe("card");
    expect(decide([asks, open], read)).toBe("card");
    expect(decide([open, asks, denies], read)).toBe("refuse");
    expect(decide([denies, open], read)).toBe("refuse");
    // A department that sets nothing keeps the default, which counts in the merge.
    expect(decide([settings(), asks], read)).toBe("card");
    expect(decide([settings({ "class:send": "deny" }), open], { ...read, tool: "GMAIL_SEND_EMAIL", cls: "send" })).toBe("refuse");
  });
  it("runs a direct-connection read only when every governing department reviewed it", () => {
    const reviewed = settings({ "app:gmail": "read-without-asking" }, ["GMAIL_FETCH_EMAILS"]);
    const unreviewed = settings({ "app:gmail": "read-without-asking" });
    expect(decide([reviewed], { ...read, direct: true })).toBe("run");
    expect(decide([unreviewed], { ...read, direct: true })).toBe("card");
    expect(decide([reviewed, unreviewed], { ...read, direct: true })).toBe("card");
    expect(decide([reviewed], { ...read, tool: "GMAIL_LIST_THREADS", direct: true })).toBe("card");
    // Reviewed is not enough without Read without asking: a direct connection defaults to Ask.
    expect(decide([settings({}, ["GMAIL_FETCH_EMAILS"])], { ...read, direct: true })).toBe("card");
  });
  it("cards whatever would run while an office desktop's settings are unchecked; Don't use and blocked still refuse, and no save can carry the mark", () => {
    const unchecked = uncheckedOfficeSettings();
    expect(decide([settings(), unchecked], read)).toBe("card");
    expect(decide([settings({ "app:gmail": "read-without-asking" }, ["GMAIL_FETCH_EMAILS"]), unchecked], { ...read, direct: true })).toBe("card");
    expect(decide([settings({ "app:gmail": "deny" }), unchecked], read)).toBe("refuse");
    expect(decide([unchecked], { ...read, cls: "blocked" })).toBe("refuse");
    expect(decide([unchecked], { ...read, tool: "GMAIL_SEND_EMAIL", cls: "send" })).toBe("card");
    expect(decide([unchecked], { group: "site:portal.example", tool: "browser_read", cls: "read" })).toBe("card");
    expect(() => normalizeApprovalSettings(unchecked)).toThrow();
  });
});
