import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HERMES_RECOMMENDED } from "./hermes-releases.ts";
import { runtimeCli } from "./hermes-paths.ts";
import { applyPropertyPack } from "./hermes-pack.ts";
import { releaseHome, resetRuntimeSelectionForTests, saveRuntimeSelection } from "./hermes-runtime-selection.ts";
import { assertRuntimeIntegrity, checkRuntimeIntegrity, clearRuntimeIntegrity, RUNTIME_DAMAGED, RUNTIME_UNCHECKED, runtimeIntegrity, verifyRuntime } from "./hermes-runtime-check.ts";
import { resetPathCache } from "./env-path.ts";
import * as custody from "./worker-custody.ts";
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
  writeFileSync(cli, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo '${version}'; exit 0; fi\n${extra}`);
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

// The real check, run against a fictional runtime: a stand-in `git` reports the
// source state, and the runtime answers --version and the ACP handshake.
describe.skipIf(process.platform === "win32")("verification that could not run is not damage", () => {
  let bin: string;
  const gitCalls = () => readFileSync(join(bin, "calls"), "utf8").trim().split("\n").filter(Boolean).length;
  const quick = (path: string, release: typeof HERMES_RECOMMENDED) => verifyRuntime(path, release, { timeoutMs: 1_000 });
  beforeEach(() => {
    bin = privateFixtureRoot(join(tmpdir(), "realbud-integrity-bin-"));
    writeFileSync(join(bin, "head"), HERMES_RECOMMENDED.commit);
    writeFileSync(join(bin, "calls"), "");
    writeFileSync(join(bin, "git"), `#!/bin/sh\necho "$*" >> '${join(bin, "calls")}'\ncase "$*" in *rev-parse*) cat '${join(bin, "head")}';; esac\n`);
    chmodSync(join(bin, "git"), 0o755);
    vi.stubEnv("OMB_EXTRA_PATH", bin); resetPathCache();
    // Answers the handshake, after a slow start while the marker exists.
    install(`if [ -f "$(dirname "$0")/fictional-slow-start" ]; then sleep 5; fi\nread line\necho '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}'\n`);
  });
  afterEach(() => { vi.restoreAllMocks(); resetPathCache(); rmSync(bin, { recursive: true, force: true }); });

  it("holds turns while worker custody refuses the check, never marks the runtime damaged, and passes once custody clears", async () => {
    vi.spyOn(custody, "workerCustodyRefusal").mockReturnValue("A fictional earlier worker is still stopping.");
    expect(await checkRuntimeIntegrity({ verify: quick })).toBe("unavailable");
    expect(custody.workerCustodyRefusal).toHaveBeenCalled();
    // Status polls keep reporting it as unchecked, never as damaged.
    expect(runtimeIntegrity({ verify: quick })).toBe("unavailable");
    await expect(assertRuntimeIntegrity({ verify: quick })).rejects.toMatchObject({ status: 503, code: "worker_runtime_unchecked", message: RUNTIME_UNCHECKED });
    vi.mocked(custody.workerCustodyRefusal).mockReturnValue(null);
    await assertRuntimeIntegrity({ verify: quick });
    expect(runtimeIntegrity({ verify: quick })).toBe("ok");
  });

  it("caches a source mismatch as damage", async () => {
    writeFileSync(join(bin, "head"), "f".repeat(40));
    expect(await checkRuntimeIntegrity({ verify: quick })).toBe("damaged");
    const calls = gitCalls();
    expect(await checkRuntimeIntegrity({ verify: quick })).toBe("damaged");
    await expect(assertRuntimeIntegrity({ verify: quick })).rejects.toMatchObject({ code: "worker_runtime_damaged" });
    expect(gitCalls()).toBe(calls);
  });

  it("treats a slow first start as unavailable and a later passing check as healthy", async () => {
    writeFileSync(join(releaseHome(home, id), "hermes-agent", "venv", "bin", "fictional-slow-start"), "");
    expect(await checkRuntimeIntegrity({ verify: quick })).toBe("unavailable");
    rmSync(join(releaseHome(home, id), "hermes-agent", "venv", "bin", "fictional-slow-start"));
    await assertRuntimeIntegrity({ verify: quick });
    expect(runtimeIntegrity({ verify: quick })).toBe("ok");
  });
});
