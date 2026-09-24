import { afterEach, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { selectedWindowsRuntimeHome, windowsHermesGit, windowsHermesRuntimeEnv } from "./hermes-runtime-env.ts";
import { releaseHome, resetRuntimeSelectionForTests, saveRuntimeSelection } from "./hermes-runtime-selection.ts";
import { runtimeCli } from "./hermes-paths.ts";

const roots: string[] = [];
function home() { const root = mkdtempSync(join(tmpdir(), "Bud runtime fixture ")); roots.push(root); return root; }
function marker(path: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "fictional fixture"); }
afterEach(() => { resetRuntimeSelectionForTests(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("finds private Git, Node and Git Bash installed after the GUI inherited PATH", () => {
  const root = home();
  marker(join(root, "git", "cmd", "git.exe")); marker(join(root, "git", "usr", "bin", "bash.exe")); marker(join(root, "node", "node.exe"));
  const original = { Path: "C:\\Windows\\System32", HERMES_HOME: "unmodified-profile", PYTHONIOENCODING: "cp1252" };
  const env = windowsHermesRuntimeEnv(root, original);
  expect(env.PATH?.split(";")).toEqual([join(root, "node"), join(root, "git", "cmd"), join(root, "git", "usr", "bin"), original.Path]);
  expect(env.Path).toBeUndefined();
  expect(env.HERMES_HOME).toBe(original.HERMES_HOME);
  expect(env.HERMES_GIT_BASH_PATH).toBe(join(root, "git", "usr", "bin", "bash.exe"));
  expect(env.PYTHONIOENCODING).toBe("utf-8"); expect(env.PYTHONUTF8).toBe("1");
  expect(windowsHermesGit(root)).toBe(join(root, "git", "cmd", "git.exe"));
  expect(original.PYTHONIOENCODING).toBe("cp1252");
});

it("does not invent dependency paths when a computer uses existing prerequisites", () => {
  const root = home();
  expect(windowsHermesGit(root)).toBe("git");
  expect(windowsHermesRuntimeEnv(root, { PATH: "C:\\known-tools" }).PATH).toBe("C:\\known-tools");
  const prepared = windowsHermesRuntimeEnv(root, { Path: "C:\\old-tools", PATH: "C:\\augmented-tools" });
  expect(prepared.PATH).toBe("C:\\augmented-tools"); expect(prepared.Path).toBeUndefined();
});

it("keeps a running worker on its current runtime dependencies after an update is staged", () => {
  const root = home(); const first = "a".repeat(40); const next = "b".repeat(40);
  marker(runtimeCli(releaseHome(root, first), "win32"));
  saveRuntimeSelection(root, { version: 1, selected: first, previous: null });
  expect(selectedWindowsRuntimeHome(root)).toBe(releaseHome(root, first));
  saveRuntimeSelection(root, { version: 1, selected: next, previous: first });
  expect(selectedWindowsRuntimeHome(root)).toBe(releaseHome(root, first));
  resetRuntimeSelectionForTests();
  expect(selectedWindowsRuntimeHome(root)).toBe(releaseHome(root, next));
});

it("does not derive a personal runtime from an unowned PATH command", () => {
  expect(selectedWindowsRuntimeHome(home())).toBeNull();
});
