import { afterEach, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { selectedWindowsRuntimeHome, windowsHermesGit, windowsHermesRuntimeEnv, withoutRuntimePathEntries } from "./hermes-runtime-env.ts";
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

it("drops only PATH entries inside RealBud's runtimes folder, keeping order and empty segments", () => {
  const root = "C:\\Users\\Fictional\\.realbud\\hermes\\runtimes";
  const other = "C:\\Users\\Fictional\\.realbud\\hermes\\runtimes-other\\bin";
  const path = ["C:\\Windows\\System32", `${root}\\${"a".repeat(40)}-111111111111\\git\\cmd`, "",
    `"c:/users/fictional/.realbud/hermes/RUNTIMES/x/node/"`, other, "C:\\Tools"].join(";");
  expect(withoutRuntimePathEntries(path, root)).toBe(["C:\\Windows\\System32", "", other, "C:\\Tools"].join(";"));
  expect(withoutRuntimePathEntries("C:\\Windows;C:\\Tools;", root)).toBeNull();
  expect(withoutRuntimePathEntries("C:\\Windows", "")).toBeNull();
});

it("never lets a candidate borrow a sibling runtime's git, node or Git Bash from the inherited environment", () => {
  const root = home(); const runtimes = join(root, "runtimes");
  const candidate = join(runtimes, `${"a".repeat(40)}-222222222222`);
  const sibling = join(runtimes, `${"a".repeat(40)}-111111111111`);
  marker(join(candidate, "node", "node.exe"));
  const env = windowsHermesRuntimeEnv(candidate, {
    PATH: ["C:\\Windows", join(sibling, "git", "cmd"), join(sibling, "node")].join(";"),
    HERMES_GIT_BASH_PATH: join(sibling, "git", "bin", "bash.exe"),
  });
  expect(env.PATH?.split(";")).toEqual([join(candidate, "node"), "C:\\Windows"]);
  expect(env.HERMES_GIT_BASH_PATH).toBeUndefined();
  expect(windowsHermesGit(candidate)).toBe("git");
  // The shared Hermes home strips the same folder; a personal Git Bash stays.
  const shared = windowsHermesRuntimeEnv(root, { PATH: `${join(sibling, "bin")};C:\\Tools`, HERMES_GIT_BASH_PATH: "C:\\Program Files\\Git\\bin\\bash.exe" });
  expect(shared.PATH).toBe("C:\\Tools"); expect(shared.HERMES_GIT_BASH_PATH).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
});
