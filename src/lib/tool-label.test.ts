import { describe, expect, it } from "vitest";

import { approvalHeadline, approvalPlace, toolLabel } from "./tool-label";

describe("toolLabel", () => {
  it("maps common tool ids to plain phrases", () => {
    expect(toolLabel("read_file")).toBe("reading a file");
    expect(toolLabel("read")).toBe("reading a file");
    expect(toolLabel("Read")).toBe("reading a file");
    expect(toolLabel("write_file")).toBe("writing a file");
    expect(toolLabel("edit")).toBe("writing a file");
    expect(toolLabel("web_search")).toBe("searching the web");
    expect(toolLabel("search")).toBe("searching the web");
    expect(toolLabel("fetch")).toBe("reading a web page");
    expect(toolLabel("http")).toBe("reading a web page");
    expect(toolLabel("shell")).toBe("running a command in the workroom");
    expect(toolLabel("bash")).toBe("running a command in the workroom");
    expect(toolLabel("terminal")).toBe("running a command in the workroom");
    expect(toolLabel("browser")).toBe("using the bounded browser");
    expect(toolLabel("computer")).toBe("using the bounded browser");
    expect(toolLabel("browser_account_confirm")).toBe("checking the account");
  });

  it("labels Bud's page reader and read-only Hermios CRM tools", () => {
    expect(toolLabel("read_page")).toBe("reading a web page");
    expect(toolLabel("mcp__web-pages__read_page")).toBe("reading a web page");
    expect(toolLabel("crm_search")).toBe("searching Hermios CRM");
    expect(toolLabel("mcp__hermios-crm__crm_search")).toBe("searching Hermios CRM");
    expect(toolLabel("mcp__hermios-crm__crm_get_record")).toBe("opening a Hermios CRM record");
    expect(toolLabel("mcp__hermios-crm__crm_set_stage")).toBe("proposing a Hermios CRM stage change");
    expect(toolLabel("crm_add_note")).toBe("proposing a Hermios CRM note");
    expect(toolLabel("crm_add_task")).toBe("proposing a Hermios CRM task");
    expect(toolLabel("mcp__reminders__set_reminder")).toBe("setting a reminder");
    expect(toolLabel("mcp__workspace-views__views_list")).toBe("checking saved views");
    expect(toolLabel("views_create")).toBe("proposing a new saved view");
    expect(toolLabel("mcp__workspace-views__views_rename")).toBe("proposing a saved view name");
    expect(toolLabel("views_set_visible")).toBe("proposing to show or hide a saved view");
    expect(toolLabel("views_reorder")).toBe("proposing a saved view order");
    expect(toolLabel("mcp__workspace-views__views_delete")).toBe("proposing to delete a saved view");
    expect(toolLabel("mcp__bank-source__bank_accounts_list")).toBe("checking the bank accounts");
    expect(toolLabel("bank_transactions_list")).toBe("reading bank transactions");
  });

  it("maps names that contain desk to the book phrase", () => {
    expect(toolLabel("desk_read")).toBe("reading the Desk book");
    expect(toolLabel("read_desk_book")).toBe("reading the Desk book");
  });

  it("humanises unknown snake and kebab ids", () => {
    expect(toolLabel("morning_arrears")).toBe("morning arrears");
    expect(toolLabel("owner-letter")).toBe("owner letter");
  });

  it("strips provider prefixes and camel case", () => {
    expect(toolLabel("mcp__ogb__computer_batch")).toBe("using the bounded browser");
    expect(toolLabel("WebSearch")).toBe("searching the web");
    expect(toolLabel("WebFetch")).toBe("reading a web page");
  });
});

describe("approvalHeadline", () => {
  it("states the action and prefixes a carried address", () => {
    expect(approvalHeadline("shell", "ls")).toBe("Running a command in the workroom");
    expect(approvalHeadline("read_file", "open 12 Oak St ledger")).toBe("For 12 Oak St · reading a file");
    expect(approvalHeadline("edit", "property: 8 Pine St")).toBe("For 8 Pine St · writing a file");
  });

  it("matches a known book address inside the payload", () => {
    expect(approvalPlace("notes for 4/22 Harbour Rd, Kingston ACT", ["4/22 Harbour Rd, Kingston ACT"])).toBe(
      "4/22 Harbour Rd",
    );
    expect(approvalHeadline("desk_get", "read 4/22 Harbour Rd, Kingston ACT", ["4/22 Harbour Rd, Kingston ACT"])).toBe(
      "For 4/22 Harbour Rd · reading the Desk book",
    );
  });

  it("returns null when the payload has no place", () => {
    expect(approvalPlace("rm -rf scratch")).toBeNull();
  });
});

describe("office connector tools", () => {
  it("names the added service and tool instead of guessing from tokens", () => {
    expect(toolLabel("mcp__office-connectors__fictional-books__search_books")).toBe("using fictional books (search books)");
    expect(toolLabel("fictional-books__create_book")).toBe("using fictional books (create book)");
  });
});
