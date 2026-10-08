import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HERMES_RECOMMENDED } from "./hermes-releases.ts";
import { runtimeCli } from "./hermes-paths.ts";
import {
  commitRuntimeSelection, heldHermesCli, importRuntimeSelection, readRuntimeSelection, releaseHome,
  resetRuntimeSelectionForTests, saveRuntimeSelection, selectedHermesCli, workerHold,
} from "./hermes-runtime-selection.ts";
import { hermesStatus } from "./hermes-status.ts";
import { controlPath, workerControlDir } from "./worker-control.ts";
import { privateFixtureRoot, writePrivateFixtureFile } from "./testing/private-profile-fixture.ts";

let home: string;
const A = `${HERMES_RECOMMENDED.commit}-aaaaaaaaaaaa`, B = `${HERMES_RECOMMENDED.commit}-bbbbbbbbbbbb`;
const runtime = (id: string) => { const cli = runtimeCli(releaseHome(home, id)); mkdirSync(dirname(cli), { recursive: true }); writeFileSync(cli, "fictional runtime"); return cli; };
const legacy = () => join(home, "realbud-runtime.json");

beforeEach(() => {
  home = privateFixtureRoot(join(tmpdir(), "realbud-selection-"));
  vi.stubEnv("REALBUD_HERMES_HOME", home); vi.stubEnv("REALBUD_HERMES_CLI", "");
  resetRuntimeSelectionForTests();
});
afterEach(() => {
  vi.unstubAllEnvs(); resetRuntimeSelectionForTests();
  rmSync(home, { recursive: true, force: true }); rmSync(workerControlDir(home), { recursive: true, force: true });
});

it("imports a worker-home selection into RealBud's own records once, leaving the original in place", async () => {
  const original = JSON.stringify({ version: 1, selected: A, previous: null, previousAvailable: false });
  writePrivateFixtureFile(legacy(), original);
  expect(await importRuntimeSelection(home)).toBe("imported");
  expect(await importRuntimeSelection(home)).toBe("current");
  expect(readFileSync(legacy(), "utf8")).toBe(original);
  expect(workerControlDir(home).startsWith(home)).toBe(false);
  expect(JSON.parse(readFileSync(controlPath(home, "runtime-selection"), "utf8"))).toMatchObject({ selected: A, previous: null });
  if (process.platform !== "win32") expect(statSync(controlPath(home, "runtime-selection")).mode & 0o777).toBe(0o600);
  expect(await importRuntimeSelection(join(home, "fictional-empty-home"))).toBe("absent");
  // The product layout: D/hermes is described by D/worker-control, beside it.
  const office = resolve("/synthetic/office");
  expect(workerControlDir(join(office, "hermes"))).toBe(join(office, "worker-control"));
});

it("keeps the selection and its history when the worker folder is deleted", async () => {
  runtime(A);
  await commitRuntimeSelection(home, { version: 1, selected: A, previous: null, previousAvailable: false }, "selected");
  rmSync(home, { recursive: true, force: true });
  expect(readRuntimeSelection(home)).toMatchObject({ selected: A, previous: null });
  const record = JSON.parse(readFileSync(controlPath(home, "runtime-selection"), "utf8"));
  expect(record.history).toEqual([expect.objectContaining({ runtime: A, event: "selected" })]);
  // Nothing on disk to launch: resolved again, never from memory.
  expect(existsSync(selectedHermesCli(home))).toBe(false);
});

it("restores a damaged selection from its last good copy at boot and keeps the damaged file", async () => {
  await commitRuntimeSelection(home, { version: 1, selected: A, previous: null }, "selected");
  await commitRuntimeSelection(home, { version: 1, selected: B, previous: A }, "selected");
  writeFileSync(controlPath(home, "runtime-selection"), "{damaged");
  expect(workerHold(home)).toBe("selection_needs_recovery");
  expect(await importRuntimeSelection(home)).toBe("current");
  expect(readRuntimeSelection(home)).toMatchObject({ selected: A });
  expect(workerHold(home)).toBeNull();
});

it("holds launches on a corrupt selection without throwing into status, and keeps the file", async () => {
  runtime(A);
  saveRuntimeSelection(home, { version: 1, selected: A, previous: null });
  expect(selectedHermesCli(home)).toBe(runtimeCli(releaseHome(home, A)));
  writeFileSync(controlPath(home, "runtime-selection"), '{"version":1,"selected":"../../personal","previous":null}');
  // Held even for a process that already resolved a working runtime.
  expect(selectedHermesCli(home)).toBe(heldHermesCli(home));
  expect(existsSync(heldHermesCli(home))).toBe(false);
  expect(() => readRuntimeSelection(home)).toThrow(/could not be read/);
  const status = await hermesStatus({ root: home });
  expect(status).toMatchObject({ ready: false, hold: "selection_needs_recovery", cli: { compatible: false } });
  expect(status.detail).toMatch(/selection needs recovery.*files are kept/);
  expect(readFileSync(controlPath(home, "runtime-selection"), "utf8")).toContain("../../personal");
  expect(await importRuntimeSelection(home)).toBe("needs_recovery");
  await expect(commitRuntimeSelection(home, { version: 1, selected: B, previous: null }, "selected")).rejects.toMatchObject({ status: 409 });
});

it("re-resolves a cached runtime that was deleted, and otherwise keeps this process on it", async () => {
  runtime(A); runtime(B);
  saveRuntimeSelection(home, { version: 1, selected: A, previous: null });
  expect(selectedHermesCli(home)).toBe(runtimeCli(releaseHome(home, A)));
  await commitRuntimeSelection(home, { version: 1, selected: B, previous: A }, "selected");
  expect(selectedHermesCli(home)).toBe(runtimeCli(releaseHome(home, A)));
  rmSync(releaseHome(home, A), { recursive: true, force: true });
  expect(selectedHermesCli(home)).toBe(runtimeCli(releaseHome(home, B)));
});

it("never overwrites a selection another setup changed", async () => {
  saveRuntimeSelection(home, { version: 1, selected: A, previous: null });
  await expect(commitRuntimeSelection(home, { version: 1, selected: B, previous: null }, "selected", { version: 1, selected: null, previous: null }))
    .rejects.toThrow(/Another setup changed/);
  expect(readRuntimeSelection(home).selected).toBe(A);
});
