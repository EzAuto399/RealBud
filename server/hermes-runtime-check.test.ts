import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HERMES_RECOMMENDED } from "./hermes-releases.ts";
import { runtimeCli } from "./hermes-paths.ts";
import { applyPropertyPack } from "./hermes-pack.ts";
import { releaseHome, resetRuntimeSelectionForTests, saveRuntimeSelection } from "./hermes-runtime-selection.ts";
import { assertRuntimeIntegrity, checkRuntimeIntegrity, clearRuntimeIntegrity, RUNTIME_DAMAGED, runtimeIntegrity } from "./hermes-runtime-check.ts";
import { applyHandsReadiness, clearHermesVersionCache, hermesStatus } from "./hermes-status.ts";
import { workerControlDir } from "./worker-control.ts";
import { privateFixtureRoot } from "./testing/private-profile-fixture.ts";

let home: string;
const id = `${HERMES_RECOMMENDED.commit}-aaaaaaaaaaaa`;
const version = `Hermes Agent v${HERMES_RECOMMENDED.product} (${HERMES_RECOMMENDED.tag.slice(1)})`;
/** A selected private runtime whose executable answers --version. */
function install(extra = ""): string {
  const cli = runtimeCli(releaseHome(home, id));
  mkdirSync(dirname(cli), { recursive: true });
  writeFileSync(cli, `#!/bin/sh\necho '${version}'\n${extra}`);
  chmodSync(cli, 0o755);
  return cli;
}
const ok = () => vi.fn(async () => version);
const refuses = () => vi.fn(async () => { throw new Error("fictional modified source files"); });

beforeEach(() => {
  home = privateFixtureRoot(join(tmpdir(), "realbud-integrity-"));
  vi.stubEnv("REALBUD_HERMES_HOME", home); vi.stubEnv("REALBUD_HERMES_CLI", "");
  saveRuntimeSelection(home, { version: 1, selected: id, previous: null });
  resetRuntimeSelectionForTests(); clearRuntimeIntegrity(); clearHermesVersionCache();
});
afterEach(() => {
  vi.unstubAllEnvs(); resetRuntimeSelectionForTests(); clearRuntimeIntegrity();
  rmSync(home, { recursive: true, force: true }); rmSync(workerControlDir(home), { recursive: true, force: true });
});

it("checks the selected runtime against its reviewed release once, and skips a custom worker", async () => {
  install();
  const verify = ok();
  expect(runtimeIntegrity({ verify })).toBe("unknown");
  await Promise.all([checkRuntimeIntegrity({ verify }), checkRuntimeIntegrity({ verify })]);
  expect(runtimeIntegrity({ verify })).toBe("ok");
  expect(verify).toHaveBeenCalledOnce();
  expect(verify).toHaveBeenCalledWith(releaseHome(home, id), HERMES_RECOMMENDED);
  await assertRuntimeIntegrity({ verify });
  vi.stubEnv("REALBUD_HERMES_CLI", "/synthetic/hermes");
  expect(await checkRuntimeIntegrity({ verify })).toBe("not_applicable");
  expect(verify).toHaveBeenCalledOnce();
});

it("refuses generation on a damaged runtime, and Repair re-runs the check", async () => {
  install();
  const verify = refuses();
  await expect(assertRuntimeIntegrity({ verify })).rejects.toMatchObject({ status: 409, code: "worker_runtime_damaged", message: RUNTIME_DAMAGED });
  expect(await checkRuntimeIntegrity({ verify })).toBe("damaged");
  expect(verify).toHaveBeenCalledOnce();
  expect(await checkRuntimeIntegrity({ verify: ok(), force: true })).toBe("ok");
});

it.skipIf(process.platform === "win32")("keeps a damaged same-version replacement not ready although it answers --version", async () => {
  applyPropertyPack(home);
  install();
  const passed = await hermesStatus({ root: home, integrity: "await", verifyRuntime: ok() });
  expect(passed).toMatchObject({ runtimeIntegrity: "ok", cli: { compatible: true } });
  const ping = { at: 1, kind: "ping" as const, ok: true, detail: "OK", workerFingerprint: passed.workerFingerprint };
  expect(applyHandsReadiness(passed, ping).ready).toBe(true);

  // Same path, same version, different files on disk.
  rmSync(releaseHome(home, id), { recursive: true, force: true });
  install("# fictional damaged copy\n");
  clearHermesVersionCache();
  const verify = refuses();
  const replaced = await hermesStatus({ root: home, integrity: "await", verifyRuntime: verify });
  expect(verify).toHaveBeenCalledOnce();
  expect(replaced.cli.versionText).toContain(HERMES_RECOMMENDED.product);
  expect(replaced).toMatchObject({ runtimeIntegrity: "damaged", cli: { installed: true, compatible: false }, detail: RUNTIME_DAMAGED });
  expect(replaced.workerFingerprint).not.toBe(passed.workerFingerprint);
  expect(applyHandsReadiness(replaced, { ...ping, workerFingerprint: replaced.workerFingerprint }).ready).toBe(false);
  // Status polls read the result; they never re-run the check.
  await hermesStatus({ root: home, verifyRuntime: verify });
  expect(verify).toHaveBeenCalledOnce();
});
