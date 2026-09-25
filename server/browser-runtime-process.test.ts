import { EventEmitter } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { privateTempRoot, removeFixture } from "./testing/private-fixture.ts";

const processCalls = vi.hoisted(() => ({ environments: [] as NodeJS.ProcessEnv[], running: false }));
// Only the fixture helper is faked. Everything else, including the Windows
// file-privacy check that promisifies execFile, runs the real command.
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const execFile = vi.fn((file, args, options, callback) => {
    if (file !== "/fixture/bsk") return actual.execFile(file, args, options, callback);
    processCalls.environments.push(options.env);
    queueMicrotask(() => callback(processCalls.running ? null : new Error("Not started"), JSON.stringify({
      daemon_version: "0.3.0", protocol_version: "1.3", browsers: [], sessions: [],
    })));
  });
  Object.assign(execFile, { [promisify.custom]: (actual.execFile as unknown as Record<symbol, unknown>)[promisify.custom] });
  return {
    ...actual,
    execFile,
    spawn: vi.fn((file, args, options) => {
      if (file !== "/fixture/bsk") return actual.spawn(file, args, options);
      processCalls.environments.push(options.env); processCalls.running = true;
      const child = Object.assign(new EventEmitter(), { exitCode: null as number | null, kill: () => {
        child.exitCode = 0; processCalls.running = false; child.emit("exit", 0); return true;
      } });
      return child;
    }),
  };
});
import { BrowserRuntime } from "./browser-runtime.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs(); processCalls.environments.length = 0; processCalls.running = false;
  await Promise.all(roots.splice(0).map(removeFixture));
});

it("owns helper updates across daemon startup and reconnect even if the parent enables auto-update", async () => {
  vi.stubEnv("BSK_AUTO_UPDATE", "on"); vi.stubEnv("BSK_UPDATE_MANIFEST_URL", "https://unreviewed.example/update");
  vi.stubEnv("OPENAI_API_KEY", "fictional-parent-key");
  const root = privateTempRoot(join(tmpdir(), "rb-browser-process-")); roots.push(root);
  const runtime = new BrowserRuntime({ root, executable: async () => "/fixture/bsk" });
  try {
    expect((await runtime.connect()).state).toBe("extension_needed");
    expect((await runtime.connect()).state).toBe("extension_needed");
    expect(processCalls.environments.length).toBeGreaterThan(4);
    for (const env of processCalls.environments) {
      expect(env.BSK_AUTO_UPDATE).toBe("off");
      expect(env.BSK_AUTO_START).toBe("0");
      expect(env.BSK_HOME).toBe(join(root, "bridge"));
      expect(env.BSK_UPDATE_MANIFEST_URL).toBeUndefined();
      expect(env.OPENAI_API_KEY).toBeUndefined();
    }
  } finally { await runtime.shutdown(); }
});
