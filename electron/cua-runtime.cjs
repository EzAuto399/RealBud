// Pure CUA runtime resolution. Packaged RealBud is an appliance: it may use
// only the executable shipped inside its own Resources directory. Development
// uses an explicit override or this checkout's prepared binary. A personal
// CuaDriver app is never inspected, attached to, updated, or reused.
const fs = require("node:fs");
const path = require("node:path");

function resolveCuaRuntime({
  packaged = false,
  resourcesPath = "",
  overridePath,
  developmentDriver,
  exists = fs.existsSync,
} = {}) {
  if (packaged) {
    const bundled = path.join(resourcesPath, "cua-driver");
    return exists(bundled) ? { path: bundled, runtime: "bundled" } : null;
  }

  if (overridePath && exists(overridePath)) {
    return { path: path.resolve(overridePath), runtime: "development" };
  }
  if (developmentDriver && exists(developmentDriver)) {
    return { path: path.resolve(developmentDriver), runtime: "development" };
  }
  return null;
}

function createCuaPreferenceStore({ getUserData, fileSystem = fs, processId = process.pid } = {}) {
  if (typeof getUserData !== "function") throw new Error("getUserData is required");

  function preferencePath() {
    return path.join(getUserData(), "cua-preference.json");
  }

  function write(enabled) {
    const userData = getUserData();
    fileSystem.mkdirSync(userData, { recursive: true });
    const target = preferencePath();
    const temporary = `${target}.${processId}.tmp`;
    try {
      fileSystem.writeFileSync(temporary, JSON.stringify({ version: 1, enabled }), { mode: 0o600 });
      fileSystem.renameSync(temporary, target);
    } catch (error) {
      try {
        fileSystem.unlinkSync(temporary);
      } catch {}
      throw error;
    }
  }

  return Object.freeze({
    enabled() {
      try {
        const parsed = JSON.parse(fileSystem.readFileSync(preferencePath(), "utf8"));
        return parsed?.version === 1 && parsed?.enabled === true;
      } catch {
        return false;
      }
    },

    enable() {
      write(true);
    },

    disable() {
      write(false);
    },
  });
}

module.exports = { createCuaPreferenceStore, resolveCuaRuntime };
