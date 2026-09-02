import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { __setCuaConnectionForTests, cuaAttendedReady, readCuaConnection } from "./local-computer.ts";

describe("local computer descriptor", () => {
  it("fails closed on Linux even when a valid-looking descriptor exists", () => {
    const userData = join(process.env.HOME!, "linux-user-data");
    mkdirSync(userData, { recursive: true });
    writeFileSync(
      join(userData, "cua-connection.json"),
      JSON.stringify({
        mode: "embedded",
        mcpCommand: "/tmp/cua-driver",
        mcpArgs: ["mcp", "--embedded"],
        mcpEnv: { CUA_DRIVER_EMBEDDED: "1" },
      }),
    );

    expect(readCuaConnection({ platform: "linux", userData })).toBeNull();
  });

  it("reads and validates an exact platform userData descriptor", () => {
    const userData = join(process.env.HOME!, "windows-user-data");
    mkdirSync(userData, { recursive: true });
    writeFileSync(
      join(userData, "cua-connection.json"),
      JSON.stringify({
        mode: "embedded",
        mcpCommand: "C:\\cua-driver.exe",
        mcpArgs: ["mcp"],
        mcpEnv: { CUA_DRIVER_EMBEDDED: "1" },
      }),
    );

    expect(readCuaConnection({ platform: "win32", userData })).toEqual({
      command: "C:\\cua-driver.exe",
      args: ["mcp"],
      env: { CUA_DRIVER_EMBEDDED: "1" },
    });
  });

  it("rejects malformed argv and environment values", () => {
    const userData = join(process.env.HOME!, "invalid-user-data");
    mkdirSync(userData, { recursive: true });
    writeFileSync(
      join(userData, "cua-connection.json"),
      JSON.stringify({ mode: "embedded", mcpCommand: "cua-driver", mcpArgs: "mcp" }),
    );

    expect(readCuaConnection({ platform: "win32", userData })).toBeNull();
  });

  it("rejects an array environment descriptor", () => {
    const userData = join(process.env.HOME!, "array-environment-user-data");
    mkdirSync(userData, { recursive: true });
    writeFileSync(
      join(userData, "cua-connection.json"),
      JSON.stringify({
        mode: "embedded",
        mcpCommand: "cua-driver",
        mcpEnv: ["CUA_DRIVER_EMBEDDED=1"],
      }),
    );

    expect(readCuaConnection({ platform: "win32", userData })).toBeNull();
  });

  afterEach(() => {
    __setCuaConnectionForTests(undefined);
    delete process.env.REALBUD_CUA_DESCRIPTOR_PATH;
    delete process.env.REALBUD_CUA_TEST_READY;
  });

  it("honours REALBUD_CUA_DESCRIPTOR_PATH and the in-process test hook", () => {
    const userData = join(process.env.HOME!, "descriptor-path-user-data");
    mkdirSync(userData, { recursive: true });
    const file = join(userData, "explicit-cua.json");
    writeFileSync(
      file,
      JSON.stringify({
        mode: "embedded",
        mcpCommand: "/tmp/cua-driver",
        mcpArgs: ["mcp"],
        mcpEnv: { CUA_DRIVER_EMBEDDED: "1" },
      }),
    );
    process.env.REALBUD_CUA_DESCRIPTOR_PATH = file;
    expect(readCuaConnection({ platform: "darwin", home: userData })).toEqual({
      command: "/tmp/cua-driver",
      args: ["mcp"],
      env: { CUA_DRIVER_EMBEDDED: "1" },
    });

    __setCuaConnectionForTests({ command: "/tmp/override", args: ["mcp"], env: {} });
    expect(readCuaConnection()).toEqual({ command: "/tmp/override", args: ["mcp"], env: {} });
    expect(cuaAttendedReady()).toBe(true);
    __setCuaConnectionForTests(null);
    expect(readCuaConnection()).toBeNull();
    expect(cuaAttendedReady()).toBe(false);
  });
});
