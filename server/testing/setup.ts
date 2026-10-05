// Vitest setup — every test file gets a throwaway home directory so
// DATA_DIR (~/.realbud) never touches the real one. os.homedir()
// reads HOME (POSIX) / USERPROFILE (Windows) at call time, and this file
// runs before any test module imports server/config.ts.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, vi } from "vitest";
import { SANDBOX_TEST_WRITABLE } from "../worker-network-sandbox.ts";

// vi.waitFor gives up after 1 s by default. The suite waits on background
// work (fsync'd private writes, child servers, approval cards) that a loaded
// machine can push past that, which failed tests that were otherwise correct.
// It still resolves as soon as the condition holds; a caller's own timeout wins.
const waitFor = vi.waitFor;
vi.waitFor = ((callback, options) => waitFor(callback,
  typeof options === "number" ? options : { timeout: 10_000, ...options })) as typeof vi.waitFor;

// Test fakes (fake CLIs, FAKE_ACP_DUMP) leave their evidence under the temp
// folder; the worker sandbox grants it only through this explicit hook.
SANDBOX_TEST_WRITABLE.push(realpathSync(tmpdir()));

const home = mkdtempSync(join(tmpdir(), "omb-test-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;

afterAll(async () => {
  // Windows holds a directory that is a live process's cwd, and a
  // just-killed CLI lets go a beat after the kill call returns (rmSync's own
  // maxRetries does not cover an EPERM on the directory itself). Retry
  // briefly — and never fail a green suite over a temp dir.
  let lastError: unknown;
  for (let i = 0; i < 20; i++) {
    try {
      return rmSync(home, { recursive: true, force: true });
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  console.warn(
    `test cleanup could not remove ${home}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
});
