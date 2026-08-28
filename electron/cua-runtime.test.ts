import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { createCuaPreferenceStore, resolveCuaRuntime } = require("./cua-runtime.cjs");

describe("CUA runtime resolution", () => {
  it("uses only RealBud's bundled driver in a packaged app", () => {
    const resourcesPath = path.join(path.sep, "Applications", "RealBud.app", "Contents", "Resources");
    const bundled = path.join(resourcesPath, "cua-driver");
    const personal = path.join(path.sep, "Applications", "CuaDriver.app", "Contents", "MacOS", "cua-driver");

    expect(
      resolveCuaRuntime({
        packaged: true,
        resourcesPath,
        overridePath: path.join(path.sep, "tmp", "sentinel-cua"),
        personalDriver: personal,
        exists: (candidate: string) => candidate === bundled || candidate === personal || candidate.includes("sentinel"),
      }),
    ).toEqual({ path: bundled, runtime: "bundled" });
  });

  it("fails closed when the packaged driver is missing", () => {
    expect(
      resolveCuaRuntime({
        packaged: true,
        resourcesPath: path.join(path.sep, "missing", "Resources"),
        overridePath: path.join(path.sep, "tmp", "sentinel-cua"),
        personalDriver: path.join(path.sep, "Applications", "CuaDriver.app", "Contents", "MacOS", "cua-driver"),
        exists: () => false,
      }),
    ).toBeNull();
  });

  it("uses an explicit or checkout-owned runtime in development and ignores a personal app", () => {
    const overridePath = path.join(path.sep, "tmp", "developer-cua");
    const developmentDriver = path.join(path.sep, "repo", "dist-native", "cua-driver");
    const personalDriver = path.join(path.sep, "Applications", "CuaDriver.app", "Contents", "MacOS", "cua-driver");
    expect(
      resolveCuaRuntime({ packaged: false, overridePath, developmentDriver, exists: (candidate: string) => candidate === overridePath }),
    ).toEqual({ path: overridePath, runtime: "development" });
    expect(
      resolveCuaRuntime({ packaged: false, developmentDriver, exists: (candidate: string) => candidate === developmentDriver }),
    ).toEqual({ path: developmentDriver, runtime: "development" });
    expect(
      resolveCuaRuntime({ packaged: false, personalDriver, exists: (candidate: string) => candidate === personalDriver }),
    ).toBeNull();
  });

  it("remembers an explicit enable atomically and treats corrupt state as off", () => {
    const userData = mkdtempSync(path.join(os.tmpdir(), "realbud-cua-preference-"));
    try {
      const store = createCuaPreferenceStore({ getUserData: () => userData, processId: 42 });
      expect(store.enabled()).toBe(false);
      store.enable();
      expect(store.enabled()).toBe(true);
      expect(JSON.parse(readFileSync(path.join(userData, "cua-preference.json"), "utf8"))).toEqual({
        version: 1,
        enabled: true,
      });
      store.disable();
      expect(store.enabled()).toBe(false);
      expect(JSON.parse(readFileSync(path.join(userData, "cua-preference.json"), "utf8"))).toEqual({
        version: 1,
        enabled: false,
      });
      writeFileSync(path.join(userData, "cua-preference.json"), "not json");
      expect(store.enabled()).toBe(false);
    } finally {
      rmSync(userData, { recursive: true, force: true });
    }
  });
});
