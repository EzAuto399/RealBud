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
