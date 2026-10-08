import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ results: [], prepares: 0, installs: 0 }));
vi.mock("electron", () => ({ app: { isPackaged: true, getPath: () => "/synthetic/home" } }));
vi.mock("./update-service-handoff.mjs", () => ({
  prepareServiceForUpdate: async () => { fixture.prepares++; return fixture.results.shift() ?? { ready: true }; },
}));

// The packaged updater is a vendored CommonJS bundle loaded through require;
// seed the require cache with a fictional one so nothing real is downloaded.
const require = createRequire(import.meta.url);
const vendored = require.resolve("./vendor/electron-updater.cjs");
const autoUpdater = { on() {}, checkForUpdates: async () => null, quitAndInstall: () => { fixture.installs++; } };

let updater, ipc;
beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  require.cache[vendored] = { id: vendored, filename: vendored, loaded: true, exports: { autoUpdater } };
  Object.assign(fixture, { results: [], prepares: 0, installs: 0 });
  updater = await import("./updater.mjs");
  const handlers = {};
  updater.registerUpdaterIpc({ handle: (name, fn) => { handlers[name] = fn; } });
  updater.startUpdater(() => null);
  ipc = handlers;
});
afterEach(() => { delete require.cache[vendored]; vi.useRealTimers(); });

describe("restart to update when the office service could not be stopped", () => {
  it("tries once more by itself and installs when the service then stops", async () => {
    fixture.results.push({ ready: false, reason: "cannot-stop" }, { ready: true });
    await ipc["update:install"]();
    expect(await ipc["update:get-state"]()).toMatchObject({ status: "downloaded", deferred: "cannot-stop", message: expect.stringMatching(/try the update again shortly/) });
    expect(fixture.installs).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fixture.prepares).toBe(2);
    expect(fixture.installs).toBe(1);
  });

  it("gives up after the second refusal and leaves the person to stop it", async () => {
    fixture.results.push({ ready: false, reason: "cannot-stop" }, { ready: false, reason: "cannot-stop" });
    await ipc["update:install"]();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fixture.prepares).toBe(2);
    await vi.advanceTimersByTimeAsync(10 * 30_000);
    expect(fixture.prepares).toBe(2);
    expect(fixture.installs).toBe(0);
    expect(await ipc["update:get-state"]()).toMatchObject({ deferred: "cannot-stop", message: expect.stringMatching(/Stop it in Settings & help/) });
  });
});
