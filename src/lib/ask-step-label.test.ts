import { describe, expect, it } from "vitest";

import { askStepLabel } from "./ask-step-label";

describe("askStepLabel", () => {
  it("names RealBud's own tool steps in plain words", () => {
    expect(askStepLabel("mcp__bank_source__bank_transactions_list")).toBe("Reading the bank feed…");
    expect(askStepLabel("mcp__bank_source__bank_accounts_list")).toBe("Checking the bank accounts…");
    expect(askStepLabel("mcp__workroom__workroom_read")).toBe("Looking through the office book…");
    expect(askStepLabel("mcp__web_pages__read_page")).toBe("Reading a web page…");
    expect(askStepLabel("mcp__hermios_crm__crm_search")).toBe("Searching Hermios…");
    expect(askStepLabel("mcp__hermios_crm__crm_add_note")).toBe("Preparing a Hermios update…");
    expect(askStepLabel("mcp__reminders__set_reminder")).toBe("Setting a reminder…");
    expect(askStepLabel("mcp__workspace_views__views_delete")).toBe("Preparing a change to your views…");
    expect(askStepLabel("mcp__workflow_settings__workflow_settings_read")).toBe("Checking the working rules…");
    expect(askStepLabel("mcp__workflow_settings__repeat_propose")).toBe("Preparing a repeat for your Schedule…");
    expect(askStepLabel("mcp__decisions__decide")).toBe("Weighing up the options…");
    expect(askStepLabel("mcp__memory_proposals__memory_propose")).toBe("Preparing a preference for you to review…");
    expect(askStepLabel("read_file")).toBe("Reading a file…");
    expect(askStepLabel("vision_analyze")).toBe("Looking at an image…");
    expect(askStepLabel("bank_transactions_list")).toBe("Reading the bank feed…");
  });

  it("reads only the identifier: the older mcp_<server>_<tool> form, hyphenated servers and a value preview", () => {
    expect(askStepLabel("mcp_bank_source_bank_transactions_list")).toBe("Reading the bank feed…");
    expect(askStepLabel("mcp_workflow_settings_workflow_settings_propose")).toBe("Preparing a change to the working rules…");
    expect(askStepLabel("mcp__hermios-crm__crm_get_record")).toBe("Opening a Hermios record…");
    expect(askStepLabel("mcp__bank_source__bank_transactions_list: acct-fictional 2026-10-01")).toBe("Reading the bank feed…");
    expect(askStepLabel("read_file: /synthetic/notes.md")).toBe("Reading a file…");
  });

  it("names Gmail and Outlook and keeps every other connected app generic", () => {
    expect(askStepLabel("mcp__connected_apps__GMAIL_LIST_THREADS")).toBe("Checking Gmail…");
    expect(askStepLabel("mcp_connected_apps_GMAIL_FETCH_MESSAGE_BY_THREAD_ID")).toBe("Checking Gmail…");
    expect(askStepLabel("mcp__office_mail__OUTLOOK_LIST_MESSAGES")).toBe("Checking Outlook…");
    expect(askStepLabel("mcp__connected_apps__GMAIL_SEND_EMAIL")).toBe("Preparing an email…");
    expect(askStepLabel("mcp__office_mail__OUTLOOK_REPLY_EMAIL")).toBe("Preparing an email…");
    expect(askStepLabel("mcp__connected_apps__GMAIL_CREATE_EMAIL_DRAFT")).toBe("Preparing an email…");
    expect(askStepLabel("mcp__connected_apps__SLACK_LIST_CHANNELS")).toBe("Checking a connected app…");
    expect(askStepLabel("mcp__connected_apps__COMPOSIO_MULTI_EXECUTE_TOOL")).toBe("Checking a connected app…");
    expect(askStepLabel("mcp__office_connectors__fictional_books__read_page")).toBe("Checking a connected app…");
  });

  it("gives no line for unknown, missing or shell-command titles", () => {
    expect(askStepLabel(undefined)).toBeNull();
    expect(askStepLabel("")).toBeNull();
    expect(askStepLabel("tool")).toBeNull();
    expect(askStepLabel("terminal")).toBeNull();
    expect(askStepLabel("python3 /synthetic/sum.py")).toBeNull();
    expect(askStepLabel("ls -la")).toBeNull();
    // A known tool name on a server RealBud does not own is not that tool.
    expect(askStepLabel("mcp__other__read_page")).toBeNull();
    expect(askStepLabel("mcp_other_bank_transactions_list")).toBeNull();
    expect(askStepLabel("mcp__bank_source__bank_transfer")).toBeNull();
    // Page tools reach the renderer as a fixed past-tense label, not an identifier.
    expect(askStepLabel("Read a page")).toBeNull();
  });

  it("writes every line in sentence case ending with one ellipsis character, with no tool name", () => {
    const titles = ["mcp__bank_source__bank_transactions_list", "mcp__connected_apps__GMAIL_LIST_THREADS", "mcp__hermios_crm__crm_search",
      "mcp__workroom__workroom_read", "mcp__office_connectors__fictional_books__search_books", "search_files", "session_search"];
    for (const title of titles) {
      const label = askStepLabel(title)!;
      expect(label).toMatch(/^[A-Z][^A-Z_]*(?:Gmail|Outlook|Hermios|Schedule)?[^A-Z_]*…$/);
      expect(label).not.toMatch(/\.\.\.|_|mcp|composio/i);
    }
  });
});
