// The relocatability gate. This is the check whose absence let a Homebrew-only
// runtime pass every test on the build machine and then fail on a customer's.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  assessRelocatability,
  classifyDependency,
  parseOtoolDependencies,
  relocatabilityProblem,
} from "../scripts/postgres-relocatable.mjs";

const created: string[] = [];
afterEach(async () => {
  for (const directory of created.splice(0)) await rm(directory, { recursive: true, force: true });
});

/** A runtime tree with the sibling directories PostgreSQL needs at run time. */
async function runtimeTree({ lib = true, share = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "rb-pg-reloc-"));
  created.push(root);
  await mkdir(join(root, "bin"), { recursive: true });
  if (lib) await mkdir(join(root, "lib"), { recursive: true });
  if (share) await mkdir(join(root, "share"), { recursive: true });
  for (const name of ["postgres", "initdb", "pg_ctl"]) await writeFile(join(root, "bin", name), "");
  return root;
}

/** otool output in the shape macOS actually prints. */
function otool(binary: string, dependencies: string[]) {
  const lines = [`${binary}:`];
  for (const dependency of dependencies) {
    lines.push(`\t${dependency} (compatibility version 1.0.0, current version 1.0.0)`);
  }
  return async () => lines.join("\n");
}

describe("otool dependency parsing", () => {
  it("extracts dependency paths and ignores the binary header", () => {
    const stdout = [
      "/x/bin/postgres:",
      "\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1356.0.0)",
      "\t@rpath/libpq.5.dylib (compatibility version 5.0.0, current version 5.16.0)",
    ].join("\n");
    expect(parseOtoolDependencies(stdout)).toEqual(["/usr/lib/libSystem.B.dylib", "@rpath/libpq.5.dylib"]);
  });

  it("ignores blank lines and non-path noise", () => {
    expect(parseOtoolDependencies("/x:\n\n\tnot a path\n")).toEqual([]);
  });
});

describe("dependency classification", () => {
  it("treats OS libraries as system", () => {
    for (const dependency of ["/usr/lib/libz.1.dylib", "/System/Library/Frameworks/LDAP.framework/Versions/A/LDAP"]) {
      expect(classifyDependency(dependency, "/app/postgres")).toBe("system");
    }
  });

  it("treats relative install names as internal, because they relocate", () => {
    for (const dependency of ["@rpath/libpq.5.dylib", "@loader_path/../lib/libpq.5.dylib", "libpq.5.dylib"]) {
      expect(classifyDependency(dependency, "/app/postgres")).toBe("internal");
    }
  });

  it("treats libraries inside the runtime as internal", () => {
    expect(classifyDependency("/app/postgres/lib/libpq.5.dylib", "/app/postgres")).toBe("internal");
  });

  it("treats a build-host package path as external", () => {
    // The exact failure this module exists for.
    expect(classifyDependency("/opt/homebrew/opt/openssl@3/lib/libssl.3.dylib", "/app/postgres")).toBe("external");
  });
});

describe("runtime relocatability", () => {
  it("accepts a runtime that carries lib and share and links only to the OS", async () => {
    const root = await runtimeTree();
    const report = await assessRelocatability(root, [join(root, "bin", "postgres")], {
      platform: "darwin",
      inspect: otool("postgres", ["/usr/lib/libSystem.B.dylib", "@rpath/libpq.5.dylib"]),
    });
    expect(report).toEqual({ relocatable: true, external: [], missing: [] });
    expect(relocatabilityProblem(report)).toBeNull();
  });

  it("rejects a package-manager runtime that links outside itself", async () => {
    const root = await runtimeTree();
    const report = await assessRelocatability(root, [join(root, "bin", "postgres")], {
      platform: "darwin",
      inspect: otool("postgres", ["/opt/homebrew/opt/openssl@3/lib/libssl.3.dylib", "/usr/lib/libSystem.B.dylib"]),
    });
    expect(report.relocatable).toBe(false);
    expect(report.external).toEqual(["/opt/homebrew/opt/openssl@3/lib/libssl.3.dylib"]);
    // The message must name the offending library so the fix is obvious.
    expect(relocatabilityProblem(report)).toContain("libssl.3.dylib");
  });

  it("rejects a bare bin directory with no lib or share tree", async () => {
    const root = await runtimeTree({ lib: false, share: false });
    const report = await assessRelocatability(root, [join(root, "bin", "postgres")], { platform: "darwin" });
    expect(report.relocatable).toBe(false);
    expect(report.missing.sort()).toEqual(["lib", "share"]);
    expect(relocatabilityProblem(report)).toMatch(/lib or share/);
  });

  it("reports duplicated dependencies once", async () => {
    const root = await runtimeTree();
    const shared = "/opt/homebrew/opt/icu4c@78/lib/libicuuc.78.dylib";
    const report = await assessRelocatability(
      root,
      [join(root, "bin", "postgres"), join(root, "bin", "initdb"), join(root, "bin", "pg_ctl")],
      { platform: "darwin", inspect: otool("postgres", [shared, shared]) },
    );
    expect(report.external).toEqual([shared]);
  });

  it("applies the structural rule on Windows, where otool does not exist", async () => {
    const root = await runtimeTree();
    const report = await assessRelocatability(root, [join(root, "bin", "postgres.exe")], { platform: "win32" });
    // Windows binaries resolve their own DLLs from bin/, so a complete tree passes.
    expect(report).toEqual({ relocatable: true, external: [], missing: [] });
  });

  it("rejects an incomplete Windows tree that carries no share data", async () => {
    const root = await runtimeTree({ share: false });
    const report = await assessRelocatability(root, [join(root, "bin", "postgres.exe")], { platform: "win32" });
    expect(report.relocatable).toBe(false);
    expect(report.missing).toEqual(["share"]);
  });

  it("does not fail a runtime merely because inspection is unavailable", async () => {
    const root = await runtimeTree();
    const report = await assessRelocatability(root, [join(root, "bin", "postgres")], {
      platform: "darwin",
      inspect: async () => { throw new Error("otool missing"); },
    });
    expect(report.relocatable).toBe(true);
  });

  it("rejects a symlinked lib directory, which an update could repoint", async () => {
    const root = await runtimeTree({ lib: false });
    const elsewhere = await mkdtemp(join(tmpdir(), "rb-pg-elsewhere-"));
    created.push(elsewhere);
    const { symlink } = await import("node:fs/promises");
    try {
      await symlink(elsewhere, join(root, "lib"));
    } catch {
      return; // symlinks unavailable
    }
    const report = await assessRelocatability(root, [join(root, "bin", "postgres")], { platform: "darwin" });
    expect(report.missing).toContain("lib");
  });
});
