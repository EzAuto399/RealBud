import path from "node:path";

/**
 * Is this override rooted on the TARGET platform?
 *
 * `path.isAbsolute` accepts "/logs" on win32, where Windows then resolves it
 * against whatever drive happens to be current — so a POSIX-shaped override is
 * accepted and silently writes the startup log somewhere other than the place
 * that was asked for. Windows therefore needs an explicit drive-letter root
 * ("C:\logs", "C:/logs") or a UNC root ("\\server\share\logs"); a drive-relative
 * "C:logs" is not rooted either. POSIX keeps its own rule.
 */
const WINDOWS_ROOT = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/;

/** @param {string} value @param {string} platform @returns {boolean} */
function rootedForPlatform(value, platform) {
  return platform === "win32" ? WINDOWS_ROOT.test(value) : path.posix.isAbsolute(value);
}

/** Select startup logging before any writer captures Electron's default path. */
export function configureLogDirectory(app, env = process.env, platform = process.platform) {
  const override = env.REALBUD_LOG_DIR;
  if (override !== undefined) {
    if (typeof override !== "string" || !rootedForPlatform(override, platform)) {
      throw new Error("REALBUD_LOG_DIR must be an absolute path.");
    }
    app.setAppLogsPath(override);
  }
  return app.getPath("logs");
}
