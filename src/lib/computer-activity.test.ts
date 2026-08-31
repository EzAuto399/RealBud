import { describe, expect, it } from "vitest";

import { activityLabel, activityLine, activityResult } from "./computer-activity";

describe("computer activity labels", () => {
  it("uses PM language for common tools and turns", () => {
    expect(activityLabel("tool", "Read")).toBe("read a file");
    expect(activityLabel("tool", "read_file")).toBe("read a file");
    expect(activityLabel("tool", "Bash")).toBe("ran a command");
    expect(activityLabel("tool", "run_command")).toBe("ran a command");
    expect(activityLabel("tool", "WebSearch")).toBe("searched the web");
    expect(activityLabel("tool", "open_url")).toBe("opened a page");
    expect(activityLabel("turn", "ask turn")).toBe("finished a turn");
    expect(activityLabel("tool", "mystery_tool")).toBe("used a tool");
  });

  it("marks ok versus denied", () => {
    expect(activityResult(true)).toBe("ok");
    expect(activityResult(false)).toBe("denied");
    expect(activityLine({ kind: "tool", name: "Read", ok: true })).toBe("read a file · ok");
    expect(activityLine({ kind: "tool", name: "Bash", ok: false })).toBe("ran a command · denied");
  });
});
