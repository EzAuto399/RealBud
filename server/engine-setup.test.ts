import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import {
  appleScriptEscape,
  assertSafeSetupCommand,
  openTerminalAndRun,
  setupCommandFor,
} from "./engine-setup.ts";

const install = {
  command: {
    darwin: "curl -fsSL https://example.test/install.sh | bash",
    linux: "curl -fsSL https://example.test/install.sh | bash",
    win32: "irm https://example.test/install.ps1 | iex",
  },
  signInCommand: "claude",
};

function launcher(outcomes: Array<"spawn" | "throw">) {
  const calls: Array<{ executable: string; args: readonly string[] }> = [];
  const run = (executable: string, args: readonly string[]) => {
    calls.push({ executable, args });
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = () => {};
    const outcome = outcomes.shift() ?? "spawn";
    queueMicrotask(() => {
      if (outcome === "throw") child.emit("error", new Error("missing"));
      else child.emit("spawn");
    });
    return child;
  };
  return { calls, run };
}

describe("setupCommandFor", () => {
  it("uses the sign-in command when the CLI is installed but logged out", () => {
    expect(
      setupCommandFor(install, { state: "available", authenticated: false }, "darwin"),
    ).toBe("claude");
  });

  it("uses the platform installer when the CLI is missing", () => {
    expect(setupCommandFor(install, { state: "unavailable" }, "darwin")).toMatch(/^curl /);
    expect(setupCommandFor(install, { state: "unavailable" }, "win32")).toMatch(/^irm /);
  });
});

describe("assertSafeSetupCommand", () => {
  it("rejects blank, oversized, or multiline commands", () => {
    expect(() => assertSafeSetupCommand("")).toThrow(/invalid/);
    expect(() => assertSafeSetupCommand("a\nb")).toThrow(/invalid/);
    expect(() => assertSafeSetupCommand("x".repeat(501))).toThrow(/invalid/);
  });
});

describe("openTerminalAndRun", () => {
  it("runs the allowlisted command inside macOS Terminal", async () => {
    const fake = launcher(["spawn"]);
    await expect(openTerminalAndRun("claude", "darwin", fake.run)).resolves.toBe(true);
    expect(fake.calls[0]).toEqual({
      executable: "osascript",
      args: ["-e", `tell application "Terminal" to do script "${appleScriptEscape("claude")}"`],
    });
  });

  it("escapes quotes so a command cannot break out of AppleScript", () => {
    expect(appleScriptEscape(`echo "hi"`)).toBe(`echo \\"hi\\"`);
  });
});
