import { describe, expect, it } from "vitest";
import { classifyAppTool, classifyAppToolCall, combineAppToolPolicies } from "./app-tool-policy.ts";

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
  describe("calendar toolkits (Composio slugs)", () => {
    const cases: Array<[string, "googlecalendar" | "outlook", "read" | "review" | "blocked"]> = [
      // Reads run without a card: finding events, listing them and checking availability.
      ["GOOGLECALENDAR_FIND_EVENT", "googlecalendar", "read"], ["GOOGLECALENDAR_EVENTS_LIST", "googlecalendar", "read"],
      ["GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS", "googlecalendar", "read"], ["GOOGLECALENDAR_EVENTS_GET", "googlecalendar", "read"],
      ["GOOGLECALENDAR_EVENTS_INSTANCES", "googlecalendar", "read"], ["GOOGLECALENDAR_FIND_FREE_SLOTS", "googlecalendar", "read"],
      ["GOOGLECALENDAR_FREE_BUSY_QUERY", "googlecalendar", "read"], ["GOOGLECALENDAR_LIST_CALENDARS", "googlecalendar", "read"],
      ["GOOGLECALENDAR_GET_CURRENT_DATE_TIME", "googlecalendar", "read"], ["GOOGLECALENDAR_SETTINGS_GET", "googlecalendar", "read"],
      ["OUTLOOK_LIST_EVENTS", "outlook", "read"], ["OUTLOOK_GET_EVENT", "outlook", "read"], ["OUTLOOK_GET_CALENDAR_VIEW", "outlook", "read"],
      ["OUTLOOK_LIST_CALENDARS", "outlook", "read"], ["OUTLOOK_FIND_MEETING_TIMES", "outlook", "read"], ["OUTLOOK_GET_SCHEDULE", "outlook", "read"],
      // Create, quick add, update, patch, move and replies get a per-instance approval card.
      ["GOOGLECALENDAR_CREATE_EVENT", "googlecalendar", "review"], ["GOOGLECALENDAR_QUICK_ADD", "googlecalendar", "review"],
      ["GOOGLECALENDAR_UPDATE_EVENT", "googlecalendar", "review"], ["GOOGLECALENDAR_PATCH_EVENT", "googlecalendar", "review"],
      ["GOOGLECALENDAR_EVENTS_MOVE", "googlecalendar", "review"], ["GOOGLECALENDAR_EVENTS_IMPORT", "googlecalendar", "review"],
      ["GOOGLECALENDAR_EVENTS_WATCH", "googlecalendar", "review"], ["GOOGLECALENDAR_CALENDAR_LIST_WATCH", "googlecalendar", "review"],
      ["GOOGLECALENDAR_BATCH_EVENTS", "googlecalendar", "review"],
      ["OUTLOOK_CALENDAR_CREATE_EVENT", "outlook", "review"], ["OUTLOOK_CREATE_CALENDAR_EVENT", "outlook", "review"],
      ["OUTLOOK_UPDATE_CALENDAR_EVENT", "outlook", "review"], ["OUTLOOK_ACCEPT_EVENT", "outlook", "review"],
      // Delete, cancel, clearing a calendar and sharing changes are refused outright.
      ["GOOGLECALENDAR_DELETE_EVENT", "googlecalendar", "blocked"], ["GOOGLECALENDAR_REMOVE_ATTENDEE", "googlecalendar", "blocked"],
      ["GOOGLECALENDAR_CLEAR_CALENDAR", "googlecalendar", "blocked"], ["GOOGLECALENDAR_CALENDARS_DELETE", "googlecalendar", "blocked"],
      ["GOOGLECALENDAR_ACL_DELETE", "googlecalendar", "blocked"],
      ["OUTLOOK_DELETE_CALENDAR_EVENT", "outlook", "blocked"], ["OUTLOOK_CANCEL_EVENT", "outlook", "blocked"],
      ["OUTLOOK_CANCEL_CALENDAR_EVENT", "outlook", "blocked"], ["OUTLOOK_CREATE_CALENDAR_PERMISSION", "outlook", "blocked"],
    ];
    it.each(cases)("%s under %s is %s", (name, app, policy) => {
      expect(classifyAppTool(name, { app })).toBe(policy);
      expect(classifyAppTool(name)).toBe(policy);
    });
    it("blocks a calendar update or patch that cancels or declines an event, and Outlook's decline", () => {
      expect(classifyAppToolCall("GOOGLECALENDAR_PATCH_EVENT", { event_id: "e1", status: "cancelled" })).toBe("blocked");
      expect(classifyAppToolCall("GOOGLECALENDAR_PATCH_EVENT", { event_id: "e1", status: " Canceled " })).toBe("blocked");
      expect(classifyAppToolCall("GOOGLECALENDAR_UPDATE_EVENT", { event_id: "e1", eventStatus: "CANCELLED" })).toBe("blocked");
      expect(classifyAppToolCall("GOOGLECALENDAR_PATCH_EVENT", { event_id: "e1", rsvp_response: "declined" })).toBe("blocked");
      expect(classifyAppToolCall("GOOGLECALENDAR_BATCH_EVENTS", { requests: [{ body: { status: "cancelled" } }] })).toBe("blocked");
      expect(classifyAppToolCall("GOOGLECALENDAR_PATCH_EVENT", { event_id: "e1", status: "confirmed", summary: "Cancelled inspection rebooked" })).toBe("review");
      expect(classifyAppToolCall("GOOGLECALENDAR_PATCH_EVENT", { event_id: "e1", rsvp_response: "accepted" })).toBe("review");
      expect(classifyAppTool("OUTLOOK_DECLINE_EVENT")).toBe("blocked");
      expect(classifyAppToolCall("OUTLOOK_DECLINE_EVENT", { event_id: "e1" }, { app: "outlook" })).toBe("blocked");
      expect(classifyAppToolCall("OUTLOOK_UPDATE_CALENDAR_EVENT", { event_id: "e1", show_as: "busy" })).toBe("review");
      // A mail tool's own fields are not calendar status.
      expect(classifyAppToolCall("OUTLOOK_UPDATE_EMAIL", { message_id: "m", flag: { flagStatus: "complete" }, status: "cancelled" })).toBe("read");
    });
    it("keeps a reviewed calendar read inside its own namespace and lets annotations tighten it", () => {
      expect(classifyAppTool("GOOGLECALENDAR_EVENTS_LIST", { app: "outlook" })).toBe("blocked");
      expect(classifyAppTool("GOOGLECALENDAR_EVENTS_LIST", { app: "googlecalendar", annotations: { readOnlyHint: false } })).toBe("review");
      expect(classifyAppTool("GOOGLECALENDAR_EVENTS_LIST", { app: "googlecalendar", annotations: { destructiveHint: true } })).toBe("blocked");
      // Resource-first naming is not read generically: an unknown verb before LIST stays reviewed.
      expect(classifyAppTool("MAILCHIMP_UNARCHIVE_LIST", { app: "mailchimp" })).toBe("review");
    });
  });
  describe("mailbox toolkits (exact Composio slugs, owner decision 2026-10-02)", () => {
    // Every slug `composio tools list gmail --limit 1000` returned on 2026-10-02.
    const gmail: Record<"read" | "review" | "blocked", string[]> = {
      read: ["FETCH_EMAILS", "FETCH_MESSAGE_BY_MESSAGE_ID", "FETCH_MESSAGE_BY_THREAD_ID", "LIST_MESSAGES", "LIST_THREADS", "LIST_HISTORY", "GET_ATTACHMENT",
        "GET_PROFILE", "WHO_AM_I", "LIST_LABELS", "GET_LABEL", "LIST_DRAFTS", "GET_DRAFT", "GET_CONTACTS", "GET_PEOPLE", "SEARCH_PEOPLE",
        "CREATE_EMAIL_DRAFT", "UPDATE_DRAFT", "DELETE_DRAFT", "ADD_LABEL_TO_EMAIL", "MODIFY_THREAD_LABELS", "BATCH_MODIFY_MESSAGES", "UNTRASH_MESSAGE", "UNTRASH_THREAD"],
      review: ["SEND_EMAIL", "REPLY_TO_THREAD", "FORWARD_MESSAGE", "SEND_DRAFT", "MOVE_TO_TRASH", "MOVE_THREAD_TO_TRASH", "CREATE_LABEL", "PATCH_LABEL", "UPDATE_LABEL",
        "IMPORT_MESSAGE", "INSERT_MESSAGE", "GET_AUTO_FORWARDING", "GET_FILTER", "LIST_FILTERS", "LIST_FORWARDING_ADDRESSES", "GET_VACATION_SETTINGS", "GET_LANGUAGE_SETTINGS",
        "LIST_SEND_AS", "SETTINGS_SEND_AS_GET", "SETTINGS_GET_IMAP", "SETTINGS_GET_POP", "LIST_CSE_IDENTITIES", "LIST_CSE_KEYPAIRS", "LIST_SMIME_INFO"],
      blocked: ["DELETE_MESSAGE", "DELETE_THREAD", "BATCH_DELETE_MESSAGES", "DELETE_LABEL", "REMOVE_LABEL", "CREATE_FILTER", "DELETE_FILTER", "UPDATE_VACATION_SETTINGS",
        "UPDATE_IMAP_SETTINGS", "UPDATE_POP_SETTINGS", "UPDATE_LANGUAGE_SETTINGS", "UPDATE_SEND_AS", "PATCH_SEND_AS", "STOP_WATCH"],
    };
    // The mail slugs of `composio tools list outlook`; calendar slugs are covered above.
    const outlook: Record<"read" | "review" | "blocked", string[]> = {
      read: ["LIST_MESSAGES", "GET_MESSAGE", "QUERY_EMAILS", "SEARCH_MESSAGES", "LIST_SENT_ITEMS_MESSAGES", "LIST_MAIL_FOLDERS", "LIST_CHILD_MAIL_FOLDERS", "GET_MAIL_FOLDER",
        "LIST_MAIL_FOLDER_MESSAGES", "GET_MAIL_DELTA", "GET_ME_MESSAGE_MIME_CONTENT", "LIST_OUTLOOK_ATTACHMENTS", "DOWNLOAD_OUTLOOK_ATTACHMENT", "GET_PROFILE", "WHO_AM_I",
        "LIST_MASTER_CATEGORIES", "CREATE_DRAFT", "CREATE_DRAFT_REPLY", "CREATE_REPLY_ALL_DRAFT", "CREATE_FORWARD_DRAFT", "ADD_MAIL_ATTACHMENT", "UPDATE_EMAIL", "BATCH_UPDATE_MESSAGES"],
      review: ["SEND_EMAIL", "REPLY_EMAIL", "FORWARD_MESSAGE", "SEND_DRAFT", "MOVE_MESSAGE", "BATCH_MOVE_MESSAGES", "MOVE_MESSAGE_FROM_FOLDER", "COPY_MESSAGE",
        "CREATE_MAIL_FOLDER", "LIST_EMAIL_RULES", "GET_MAILBOX_SETTINGS"],
      blocked: ["DELETE_MESSAGE", "PERMANENT_DELETE_MESSAGE", "DELETE_MESSAGE_PERMANENTLY_FROM_FOLDER", "DELETE_MAIL_FOLDER", "DELETE_CHILD_FOLDER_MESSAGE",
        "CREATE_EMAIL_RULE", "UPDATE_EMAIL_RULE", "DELETE_EMAIL_RULE", "CREATE_MAIL_FOLDER_MESSAGE_RULE", "UPDATE_USER_MAIL_FOLDER_MESSAGE_RULE",
        "UPDATE_MAILBOX_SETTINGS", "UPDATE_INFERENCE_CLASSIFICATION"],
    };
    const rows = (app: "gmail" | "outlook", table: typeof gmail) => (Object.entries(table) as Array<["read" | "review" | "blocked", string[]]>)
      .flatMap(([policy, names]) => names.map(name => [`${app.toUpperCase()}_${name}`, app, policy] as const));
    it("lists all 62 Gmail slugs exactly once", () => {
      expect(new Set(Object.values(gmail).flat()).size).toBe(62);
    });
    it.each([...rows("gmail", gmail), ...rows("outlook", outlook)])("%s under %s is %s", (name, app, policy) => {
      expect(classifyAppTool(name, { app })).toBe(policy);
      expect(classifyAppTool(name)).toBe(policy);
    });
    it("decides reviewed mail slugs itself: provider hints neither block a reviewed send nor turn a write into a read", () => {
      // Composio tags GMAIL_SEND_DRAFT and GMAIL_DELETE_DRAFT destructive.
      expect(classifyAppTool("GMAIL_SEND_DRAFT", { app: "gmail", annotations: { destructiveHint: true } })).toBe("review");
      expect(classifyAppTool("GMAIL_DELETE_DRAFT", { app: "gmail", annotations: { destructiveHint: true } })).toBe("read");
      expect(classifyAppTool("GMAIL_SEND_EMAIL", { app: "gmail", annotations: { readOnlyHint: true } })).toBe("review");
      expect(classifyAppTool("GMAIL_LIST_THREADS", { app: "outlook" })).toBe("blocked");
    });
    it.each(["GMAIL_FROBNICATE", "GMAIL_LIST_SCHEDULED_SENDS", "GMAIL_GET_NEW_THING", "OUTLOOK_LIST_FOCUSED_MESSAGES", "OUTLOOK_GET_INBOX_SUMMARY", "OUTLOOK_FROBNICATE_MAIL"])("reviews an unknown mail tool, never reads it: %s", name => {
      expect(classifyAppTool(name)).toBe("review");
      expect(classifyAppTool(name, { annotations: { readOnlyHint: true } })).toBe("review");
    });
    it("still blocks an unknown mail tool that destroys or administers, and leaves Outlook's non-mail tools to the general rule", () => {
      for (const name of ["GMAIL_EMPTY_TRASH", "GMAIL_PURGE_SPAM", "OUTLOOK_EMPTY_DELETED_ITEMS_MAIL", "GMAIL_UPDATE_DELEGATE_PERMISSIONS"]) expect(classifyAppTool(name)).toBe("blocked");
      expect(classifyAppTool("GMAIL_LIST_DELEGATES", { annotations: { destructiveHint: true } })).toBe("blocked");
      expect(classifyAppTool("OUTLOOK_LIST_CONTACTS")).toBe("read");
      expect(classifyAppTool("OUTLOOK_LIST_CHAT_MESSAGES")).toBe("read");
      expect(classifyAppTool("OUTLOOK_UPDATE_CONTACT")).toBe("review");
    });
    it("reviews a Gmail label edit that moves mail to or from Trash; archive, read and star stay card-free", () => {
      expect(classifyAppToolCall("GMAIL_ADD_LABEL_TO_EMAIL", { message_id: "abc", remove_label_ids: ["INBOX", "UNREAD"], add_label_ids: ["STARRED"] })).toBe("read");
      expect(classifyAppToolCall("GMAIL_ADD_LABEL_TO_EMAIL", { message_id: "abc", add_label_ids: ["trash"] })).toBe("review");
      expect(classifyAppToolCall("GMAIL_MODIFY_THREAD_LABELS", { thread_id: "abc", add_label_ids: ["TRASH"] })).toBe("review");
      expect(classifyAppToolCall("GMAIL_BATCH_MODIFY_MESSAGES", { messageIds: ["a", "b"], addLabelIds: ["TRASH"] })).toBe("review");
      expect(classifyAppToolCall("GMAIL_BATCH_MODIFY_MESSAGES", { messageIds: ["a"], removeLabelIds: ["INBOX"] })).toBe("read");
      // Nesting too deep to be a label list is held, not read.
      expect(classifyAppToolCall("GMAIL_ADD_LABEL_TO_EMAIL", { a: { b: { c: { d: { e: { f: "INBOX" } } } } } })).toBe("review");
    });
    it("reviews a Gmail label edit that marks mail as spam, like Trash", () => {
      expect(classifyAppToolCall("GMAIL_ADD_LABEL_TO_EMAIL", { message_id: "abc", add_label_ids: ["SPAM"] })).toBe("review");
      expect(classifyAppToolCall("GMAIL_BATCH_MODIFY_MESSAGES", { messageIds: ["a"], addLabelIds: ["spam"] })).toBe("review");
      expect(classifyAppToolCall("GMAIL_MODIFY_THREAD_LABELS", { thread_id: "abc", add_label_ids: ["IMPORTANT"] })).toBe("read");
    });
    it("runs an Outlook move without a card only when it archives", () => {
      expect(classifyAppToolCall("OUTLOOK_MOVE_MESSAGE", { message_id: "m", destination_id: "archive" })).toBe("read");
      expect(classifyAppToolCall("OUTLOOK_BATCH_MOVE_MESSAGES", { message_ids: ["m"], destination_id: "Inbox" })).toBe("read");
      expect(classifyAppToolCall("OUTLOOK_MOVE_MESSAGE", { message_id: "m", destination_id: "deleteditems" })).toBe("review");
      expect(classifyAppToolCall("OUTLOOK_MOVE_MESSAGE", { message_id: "m", destination_id: "AAMkFolderOpaqueId" })).toBe("review");
      expect(classifyAppToolCall("OUTLOOK_MOVE_MESSAGE", { message_id: "m" })).toBe("review");
      expect(classifyAppToolCall("OUTLOOK_SEND_EMAIL", { to: "fictional@example.test", destination_id: "archive" })).toBe("review");
      expect(classifyAppToolCall("OUTLOOK_DELETE_MESSAGE", { destination_id: "archive" })).toBe("blocked");
    });
    it("is as strict as the strictest member across a mailbox batch", () => {
      expect(combineAppToolPolicies(["GMAIL_LIST_THREADS", "GMAIL_CREATE_EMAIL_DRAFT"].map(name => classifyAppTool(name)))).toBe("read");
      expect(combineAppToolPolicies(["GMAIL_LIST_THREADS", "OUTLOOK_SEND_EMAIL"].map(name => classifyAppTool(name)))).toBe("review");
      expect(combineAppToolPolicies(["GMAIL_SEND_EMAIL", "GMAIL_CREATE_FILTER"].map(name => classifyAppTool(name)))).toBe("blocked");
    });
  });
  it("combines a batch to its strictest member", () => {
    expect(combineAppToolPolicies([])).toBe("blocked");
    expect(combineAppToolPolicies(["read", "read"])).toBe("read");
    expect(combineAppToolPolicies(["read", "review"])).toBe("review");
    expect(combineAppToolPolicies(["read", "review", "blocked"])).toBe("blocked");
  });
});
