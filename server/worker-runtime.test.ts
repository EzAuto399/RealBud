import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  activateStagedWorkerRuntime,
  commitActivatedWorkerRuntime,
  prepareWorkerRuntimeStage,
  recoverInterruptedWorkerUpdate,
  rollbackActivatedWorkerRuntime,
  workerRuntimePaths,
  type WorkerRuntimeSlot,
} from "./worker-runtime.ts";

const roots: string[] = [];
const scratch = () => {
  const root = mkdtempSync(join(tmpdir(), "realbud-runtime-"));
  roots.push(root);
  return root;
};

const marker = (dir: string, value: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "marker"), value);
};

const linkActive = (root: string, slot: WorkerRuntimeSlot) => {
  const paths = workerRuntimePaths(root);
  mkdirSync(paths.slotsDir, { recursive: true });
  symlinkSync(join(".runtime-slots", slot), paths.active, "dir");
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("worker runtime transaction", () => {
  it("migrates a legacy active directory only after the stable slot is ready", () => {
    const root = scratch();
    const paths = workerRuntimePaths(root);
    marker(paths.active, "legacy-worker");

    const prepared = prepareWorkerRuntimeStage(root);
    expect(prepared.slot).toBe("a");
    marker(prepared.staged, "new-worker");
    const activated = activateStagedWorkerRuntime(root, prepared.slot);

    expect(activated.previousAvailable).toBe(true);
    expect(readFileSync(join(paths.active, "marker"), "utf8")).toBe("new-worker");
    expect(readFileSync(join(paths.legacyPrevious, "marker"), "utf8")).toBe("legacy-worker");
    expect(existsSync(paths.activationPending)).toBe(true);
    commitActivatedWorkerRuntime(root);
    expect(existsSync(paths.activationPending)).toBe(false);
  });

  it("alternates stable A/B slots so installer absolute paths remain valid", () => {
    const root = scratch();
    const paths = workerRuntimePaths(root);
    marker(paths.slotA, "worker-a");
    linkActive(root, "a");

    const prepared = prepareWorkerRuntimeStage(root);
    expect(prepared.slot).toBe("b");
    expect(prepared.staged).toBe(paths.slotB);
    marker(prepared.staged, "worker-b");
    activateStagedWorkerRuntime(root, prepared.slot);
    commitActivatedWorkerRuntime(root);

    expect(readFileSync(join(paths.active, "marker"), "utf8")).toBe("worker-b");
    expect(readFileSync(join(paths.slotA, "marker"), "utf8")).toBe("worker-a");
  });

  it("discards a crash before the active-link switch without changing the worker", () => {
    const root = scratch();
    const paths = workerRuntimePaths(root);
    marker(paths.slotA, "worker-a");
    marker(paths.slotB, "candidate-b");
    linkActive(root, "a");
    writeFileSync(paths.activationPending, '{"version":1,"candidate":"b","previous":"a"}\n');

    const recovery = recoverInterruptedWorkerUpdate(root);

    expect(recovery.action).toBe("discarded-staging");
    expect(readFileSync(join(paths.active, "marker"), "utf8")).toBe("worker-a");
    expect(existsSync(paths.slotB)).toBe(false);
    expect(existsSync(paths.activationPending)).toBe(false);
  });

  it("rolls back a crash after the active-link switch but before its health receipt", () => {
    const root = scratch();
    const paths = workerRuntimePaths(root);
    marker(paths.slotA, "known-worker");
    linkActive(root, "a");
    const prepared = prepareWorkerRuntimeStage(root);
    marker(prepared.staged, "new-unconfirmed-worker");
    activateStagedWorkerRuntime(root, prepared.slot);

    const recovery = recoverInterruptedWorkerUpdate(root);

    expect(recovery.action).toBe("restored-previous");
    expect(readFileSync(join(paths.active, "marker"), "utf8")).toBe("known-worker");
    expect(existsSync(paths.activationPending)).toBe(false);
  });

  it("never promotes an unconfirmed first install during boot recovery", () => {
    const root = scratch();
    const paths = workerRuntimePaths(root);
    const prepared = prepareWorkerRuntimeStage(root);
    marker(prepared.staged, "unconfirmed-worker");
    activateStagedWorkerRuntime(root, prepared.slot);

    const recovery = recoverInterruptedWorkerUpdate(root);

    expect(recovery.action).toBe("quarantined-staging");
    expect(existsSync(paths.active)).toBe(false);
    expect(existsSync(paths.slotA)).toBe(false);
  });

  it("never promotes a first install interrupted before its active link existed", () => {
    const root = scratch();
    const paths = workerRuntimePaths(root);
    marker(paths.slotA, "candidate-only");
    writeFileSync(paths.activationPending, '{"version":1,"candidate":"a","previous":null}\n');

    const recovery = recoverInterruptedWorkerUpdate(root);

    expect(recovery.action).toBe("quarantined-staging");
    expect(existsSync(paths.active)).toBe(false);
    expect(existsSync(paths.slotA)).toBe(false);
    expect(existsSync(paths.activationPending)).toBe(false);
  });

  it("rolls an unhealthy activation back and discards the rejected slot", () => {
    const root = scratch();
    const paths = workerRuntimePaths(root);
    marker(paths.slotA, "known-worker");
    linkActive(root, "a");
    const prepared = prepareWorkerRuntimeStage(root);
    marker(prepared.staged, "new-but-unhealthy");
    activateStagedWorkerRuntime(root, prepared.slot);

    expect(rollbackActivatedWorkerRuntime(root)).toBe(true);
    expect(readFileSync(join(paths.active, "marker"), "utf8")).toBe("known-worker");
    expect(existsSync(paths.slotB)).toBe(false);
    expect(existsSync(paths.activationPending)).toBe(false);
  });

  it("fails closed on an active link outside RealBud's two slots", () => {
    const root = scratch();
    const paths = workerRuntimePaths(root);
    const outside = join(root, "outside-runtime");
    marker(outside, "outside");
    symlinkSync("outside-runtime", paths.active, "dir");

    const recovery = recoverInterruptedWorkerUpdate(root);

    expect(recovery.action).toBe("attention");
    expect(() => prepareWorkerRuntimeStage(root)).toThrow(/attention/);
    expect(readFileSync(join(outside, "marker"), "utf8")).toBe("outside");
  });

  it("lets a deliberate reinstall replace a corrupt receipt only with a managed active slot", () => {
    const root = scratch();
    const paths = workerRuntimePaths(root);
    marker(paths.slotA, "known-worker");
    linkActive(root, "a");
    writeFileSync(paths.activationPending, "not-json\n");

    expect(recoverInterruptedWorkerUpdate(root).action).toBe("attention");
    const prepared = prepareWorkerRuntimeStage(root);

    expect(prepared.slot).toBe("b");
    expect(readFileSync(join(paths.active, "marker"), "utf8")).toBe("known-worker");
    expect(existsSync(paths.activationPending)).toBe(false);
  });
});
