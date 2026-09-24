import { describe, expect, it } from "vitest";
import path from "node:path";
import { configureLogDirectory } from "./log-directory.mjs";

function fixture() {
  const calls = [];
  let location = path.resolve("fictional-default-logs");
  return {
    calls,
    app: {
      setAppLogsPath(value) { calls.push(["set", value]); location = value; },
      getPath(name) { calls.push(["get", name]); return location; },
    },
  };
}

describe("startup log directory", () => {
  it("retains Electron's default unless an override is explicitly supplied", () => {
    const { app, calls } = fixture();
    expect(configureLogDirectory(app, {})).toBe(path.resolve("fictional-default-logs"));
    expect(calls).toEqual([["get", "logs"]]);
  });

  it.each(["relative/logs", "", "../logs"])("rejects invalid override %j before changing or capturing a log path", override => {
    const { app, calls } = fixture();
    expect(() => configureLogDirectory(app, { REALBUD_LOG_DIR: override })).toThrow("must be an absolute path");
    expect(calls).toEqual([]);
  });

  it("applies an absolute override before the first captured writer path", () => {
    const { app, calls } = fixture();
    const override = path.resolve("fictional isolated home", "logs");
    expect(configureLogDirectory(app, { REALBUD_LOG_DIR: override })).toBe(override);
    expect(calls).toEqual([["set", override], ["get", "logs"]]);
  });

  // `path.isAbsolute` says yes to "/logs" on win32, where Windows resolves it
  // against the current drive — the log would land on a drive nobody chose.
  it.each(["/logs", "\\logs", "C:logs", "\\\\srv"])("rejects %j as a Windows log root", override => {
    const { app, calls } = fixture();
    expect(() => configureLogDirectory(app, { REALBUD_LOG_DIR: override }, "win32")).toThrow("must be an absolute path");
    expect(calls).toEqual([]);
  });

  it.each(["C:\\logs", "C:/logs", "\\\\srv\\share\\logs"])("accepts %j as a Windows log root", override => {
    const { app } = fixture();
    expect(configureLogDirectory(app, { REALBUD_LOG_DIR: override }, "win32")).toBe(override);
  });

  it("keeps POSIX roots valid on darwin", () => {
    const { app, calls } = fixture();
    expect(configureLogDirectory(app, { REALBUD_LOG_DIR: "/logs" }, "darwin")).toBe("/logs");
    expect(calls).toEqual([["set", "/logs"], ["get", "logs"]]);
  });
});
