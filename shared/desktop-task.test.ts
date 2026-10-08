import { describe, expect, it } from "vitest";
import { parseDesktopTarget, parseDesktopWindows } from "./desktop-task.ts";

const target = () => ({ appName: "Mail", bundleId: "com.apple.mail", pid: 4242, windowId: 7001, title: "Fictional inbox" });
const DAMAGED = "This app window is incomplete or damaged. Choose the window again.";

describe("desktop target", () => {
  it("round-trips a window, including an untitled one", () => {
    expect(parseDesktopTarget(target())).toEqual(target());
    expect(parseDesktopTarget({ ...target(), title: "" }).title).toBe("");
  });

  it.each([
    ["an unknown key", { ...target(), url: "https://portal.example" }],
    ["a missing key", { appName: "Mail", bundleId: "com.apple.mail", pid: 4242, windowId: 7001 }],
    ["an empty app name", { ...target(), appName: " " }],
    ["a long app name", { ...target(), appName: "M".repeat(201) }],
    ["a bundle id with a slash", { ...target(), bundleId: "com.apple/mail" }],
    ["a pid that is not a safe integer", { ...target(), pid: 2 ** 53 }],
    ["a fractional window id", { ...target(), windowId: 1.5 }],
    ["a zero pid", { ...target(), pid: 0 }],
    ["a pid given as text", { ...target(), pid: "4242" }],
    ["a title with a control character", { ...target(), title: "Inbox\u0007" }],
    ["a long title", { ...target(), title: "t".repeat(501) }],
    ["an array", [target()]],
  ])("refuses %s", (_name, value) => {
    expect(() => parseDesktopTarget(value)).toThrow(DAMAGED);
  });

  it("parses the window list exactly", () => {
    expect(parseDesktopWindows({ windows: [target()] })).toEqual({ windows: [target()] });
    expect(parseDesktopWindows({ windows: [] })).toEqual({ windows: [] });
    for (const bad of [{ windows: [target()], extra: 1 }, { windows: [target(), target()] }, { windows: "none" }, { windows: Array.from({ length: 201 }, (_, i) => ({ ...target(), windowId: i + 1 })) }]) {
      expect(() => parseDesktopWindows(bad)).toThrow(DAMAGED);
    }
  });
});
