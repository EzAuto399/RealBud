import { describe, expect, it } from "vitest";
import { classifyAppTool, combineAppToolPolicies } from "./app-tool-policy.ts";

describe("classifyAppTool", () => {
  it.each(["XERO_GET_INVOICES", "SLACK_LIST_CHANNELS", "NOTION_SEARCH_PAGES", "GITHUB_FETCH_ISSUE", "OUTLOOK_LOOKUP_CONTACT", "HUBSPOT_COUNT_DEALS",
    // Whole tokens: BANK is not BAN, CALL is not ALL, a list of all channels is a list, a batch get is a get.
    "XERO_GET_BANK_TRANSACTIONS", "TWILIO_LIST_CALL_LOGS", "SLACK_LIST_ALL_CHANNELS", "GOOGLESHEETS_BATCH_GET"])("reads: %s", name => {
    expect(classifyAppTool(name)).toBe("read");
  });
  it.each(["XERO_CREATE_INVOICE", "SLACK_POST_MESSAGE", "NOTION_UPDATE_PAGE", "GITHUB_CLOSE_ISSUE", "OUTLOOK_SEND_MAIL", "STRIPE_PAY_INVOICE", "XERO_APPROVE_BILL", "SLACK_FROBNICATE",
    // A read verb followed by a write token is a write; a batch write is a write; a run query may have side effects.
    "GITHUB_GET_OR_CREATE_LABEL", "SLACK_LIST_AND_ARCHIVE_CHANNELS", "XERO_BATCH_CREATE_INVOICES", "BIGQUERY_RUN_QUERY", "GOOGLESHEETS_BATCH_UPDATE", "NOTION_FIND_OR_ADD_PAGE"])("reviews writes, sends, payments and unknown verbs: %s", name => {
    expect(classifyAppTool(name)).toBe("review");
  });
  it.each(["SLACK_DELETE_MESSAGE", "NOTION_REMOVE_PAGE", "GITHUB_BULK_CLOSE_ISSUES", "SLACK_ADMIN_USERS_SET_OWNER", "GITHUB_REVOKE_TOKEN", "GOOGLEDRIVE_EMPTY_TRASH", "OUTLOOK_PURGE_FOLDER", "GITHUB_TRANSFER_OWNERSHIP",
    "XERO_VOID_INVOICE", "SLACK_CLEAR_CHANNEL", "STRIPE_RESET_KEY", "AWS_TERMINATE_INSTANCE", "GOOGLESHEETS_BATCH_DELETE_ROWS", "GOOGLEDRIVE_GET_PERMISSIONS"])("blocks destructive, bulk and administrative tools: %s", name => {
    expect(classifyAppTool(name)).toBe("blocked");
  });
  it("blocks malformed names, meta tools and names outside the app namespace", () => {
    for (const name of ["", "get_invoices", "XERO", "XERO_", "_GET", "COMPOSIO_SEARCH_TOOLS", 42, null]) expect(classifyAppTool(name as never)).toBe("blocked");
    expect(classifyAppTool("SLACK_LIST_CHANNELS", { app: "xero" })).toBe("blocked");
    expect(classifyAppTool("XERO_LIST_CONTACTS", { app: "xero" })).toBe("read");
    expect(classifyAppTool("GOOGLE_CALENDAR_LIST_EVENTS", { app: "google-calendar" })).toBe("read");
  });
  it("lets provider annotations only tighten the class", () => {
    expect(classifyAppTool("XERO_GET_INVOICES", { annotations: { readOnlyHint: false } })).toBe("review");
    expect(classifyAppTool("XERO_GET_INVOICES", { annotations: { destructiveHint: true } })).toBe("blocked");
    expect(classifyAppTool("XERO_CREATE_INVOICE", { annotations: { readOnlyHint: true } })).toBe("review");
    expect(classifyAppTool("XERO_GET_INVOICES", { annotations: { readOnlyHint: "true" } })).toBe("read");
  });
  it("combines a batch to its strictest member", () => {
    expect(combineAppToolPolicies([])).toBe("blocked");
    expect(combineAppToolPolicies(["read", "read"])).toBe("read");
    expect(combineAppToolPolicies(["read", "review"])).toBe("review");
    expect(combineAppToolPolicies(["read", "review", "blocked"])).toBe("blocked");
  });
});
