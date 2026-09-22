import { describe, expect, it } from "vitest";
import { access, mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import { assertDesktopPackagingTarget, copyPackageRuntime, listPackageZip } from "../scripts/package-files.mjs";

const repoFile = (name) => new URL(`../${name}`, import.meta.url);

// The smoke script asserts its inventory inside the installed Windows app and
// begins with a win32 assertion, so it cannot be imported here. Read the list
// out of the source instead, so a renamed module fails on every OS rather than
// only in a manual Windows run.
async function packagedInventory() {
  const source = await readFile(repoFile("scripts/smoke-windows-package.mjs"), "utf8");
  const found = source.match(/for \(const file of (\[[\s\S]*?\])\) assert\.ok\(existsSync\(join\(resources, file\)\)/);
  expect(found, "smoke-windows-package.mjs no longer declares a resource inventory this test can read").toBeTruthy();
  return JSON.parse(found[1]);
}

/** The `to:` layout electron-builder stages under the installed resources dir. */
async function windowsStagingRules() {
  const builder = parseYaml(await readFile(repoFile("electron-builder.yml"), "utf8"));
  return [...(builder.extraResources ?? []), ...(builder.win?.extraResources ?? [])];
}

function stagedSource(resourcePath, rules) {
  const matches = rules.flatMap((rule) => {
    const to = rule.to.replaceAll("\\", "/");
    if (to === ".") {
      if (resourcePath.includes("/")) return [];
      if (rule.filter && !rule.filter.includes(resourcePath)) return [];
      return [`${rule.from}/${resourcePath}`];
    }
    if (to === resourcePath) return [rule.from];
    if (resourcePath.startsWith(`${to}/`)) return [`${rule.from}/${resourcePath.slice(to.length + 1)}`];
    return [];
  });
  return matches;
}

// Staged by a build step (Vite, tsc, prepare-cua, prepare-postgres, the Windows
// speech helper), so no checked-in file corresponds one-to-one.
const BUILD_STAGED = /^(dist|dist-browser|dist-native|dist-postgres|electron\/resources\/RealBud Speech\.exe)(\/|$)/;

/** dist-server is tsc output: map the shipped .js back to its checked-in .ts. */
function checkedInSource(source) {
  if (source.startsWith("dist-server/")) {
    const compiled = source.slice("dist-server/".length);
    return compiled.endsWith(".js") ? `${compiled.slice(0, -3)}.ts` : compiled;
  }
  if (BUILD_STAGED.test(source)) return null;
  return source;
}

// A real ZIP containing only fictional runtime markers; no download or executable.
const zip = "UEsDBBQAAAAAALdiNV0C5EsjEQAAABEAAAAWAAAAcGdzcWwvYmluL3Bvc3RncmVzLmV4ZXN5bnRoZXRpYyBmaXh0dXJlUEsDBBQAAAAAALdiNV0C5EsjEQAAABEAAAAVAAAAcGdzcWwvbGliL3J1bnRpbWUuZGxsc3ludGhldGljIGZpeHR1cmVQSwMEFAAAAAAAt2I1XQLkSyMRAAAAEQAAABgAAABwZ3NxbC9zaGFyZS9wb3N0Z3Jlcy5ia2lzeW50aGV0aWMgZml4dHVyZVBLAwQUAAAAAAC3YjVdAuRLIxEAAAARAAAAGAAAAHBnc3FsL3NlcnZlcl9saWNlbnNlLnR4dHN5bnRoZXRpYyBmaXh0dXJlUEsBAhQDFAAAAAAAt2I1XQLkSyMRAAAAEQAAABYAAAAAAAAAAAAAAIABAAAAAHBnc3FsL2Jpbi9wb3N0Z3Jlcy5leGVQSwECFAMUAAAAAAC3YjVdAuRLIxEAAAARAAAAFQAAAAAAAAAAAAAAgAFFAAAAcGdzcWwvbGliL3J1bnRpbWUuZGxsUEsBAhQDFAAAAAAAt2I1XQLkSyMRAAAAEQAAABgAAAAAAAAAAAAAAIABiQAAAHBnc3FsL3NoYXJlL3Bvc3RncmVzLmJraVBLAQIUAxQAAAAAALdiNV0C5EsjEQAAABEAAAAYAAAAAAAAAAAAAACAAdAAAABwZ3NxbC9zZXJ2ZXJfbGljZW5zZS50eHRQSwUGAAAAAAQABAATAQAAFwEAAAAA";

describe("portable desktop staging", () => {
  it("lists a real ZIP using the current host's native extractor, with spaces in paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "RealBud packaging fixture "));
    try {
      const archive = join(root, "office runtime.zip");
      await writeFile(archive, Buffer.from(zip, "base64"));
      expect(await listPackageZip(archive)).toEqual([
        "pgsql/bin/postgres.exe", "pgsql/lib/runtime.dll", "pgsql/share/postgres.bki", "pgsql/server_license.txt",
      ]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("selects system Windows tar without relying on Unix tools or a shell", async () => {
    const calls = [];
    const entries = await listPackageZip("D:\\build space\\runtime.zip", {
      platform: "win32", env: { SystemRoot: "D:\\Windows" },
      execute: async (...args) => { calls.push(args); return { stdout: "pgsql/bin/postgres.exe\r\npgsql/server_license.txt\r\n" }; },
    });
    expect(calls[0][0]).toBe("D:\\Windows\\System32\\tar.exe");
    expect(calls[0][1]).toEqual(["-tf", "D:\\build space\\runtime.zip"]);
    expect(entries).toHaveLength(2);
  });

  it("copies a complete runtime into a fresh path without cp on PATH", async () => {
    const root = await mkdtemp(join(tmpdir(), "RealBud runtime fixture "));
    try {
      const source = join(root, "source"); const target = join(root, "installed runtime");
      for (const part of ["bin", "lib", "share"]) {
        await mkdir(join(source, part), { recursive: true });
        await writeFile(join(source, part, "fixture.txt"), `${part}: café`);
      }
      if (process.platform !== "win32") await symlink("fixture.txt", join(source, "lib", "relative-link"));
      await copyPackageRuntime(source, target);
      await rm(source, { recursive: true, force: true });
      for (const part of ["bin", "lib", "share"]) expect(await readFile(join(target, part, "fixture.txt"), "utf8")).toBe(`${part}: café`);
      if (process.platform !== "win32") {
        expect(await readlink(join(target, "lib", "relative-link"))).toBe("fixture.txt");
        expect(await readFile(join(target, "lib", "relative-link"), "utf8")).toBe("lib: café");
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("refuses unsupported hosts before mixing target native SDKs", () => {
    expect(() => assertDesktopPackagingTarget("darwin", "arm64")).not.toThrow();
    expect(() => assertDesktopPackagingTarget("win32", "x64")).not.toThrow();
    for (const [platform, arch] of [["darwin", "x64"], ["win32", "arm64"], ["linux", "x64"]]) {
      expect(() => assertDesktopPackagingTarget(platform, arch)).toThrow(/No complete desktop runtime/);
    }
  });
});

// The installed-resource inventory in scripts/smoke-windows-package.mjs only
// runs inside a built Windows app. Everything below is a source cross-check on
// every OS: it proves the inventory and the packaging rules still agree and
// that the named server modules still exist, never that a build produced them.
describe("Windows packaged-resource inventory", () => {
  it("reads a full inventory, including the privacy and profile modules it exists to protect", async () => {
    const inventory = await packagedInventory();
    expect(inventory.length).toBeGreaterThan(10);
    for (const required of ["server/windows-file-privacy.js", "server/hermes-profile-storage.js", "server/index.js", "ui/index.html"]) {
      expect(inventory).toContain(required);
    }
  });

  it("stages every asserted resource through exactly one extraResources rule", async () => {
    const [inventory, rules] = await Promise.all([packagedInventory(), windowsStagingRules()]);
    const unmatched = inventory.filter((file) => stagedSource(file, rules).length !== 1);
    expect(unmatched, "no single electron-builder extraResources rule stages these").toEqual([]);
  });

  it("keeps a checked-in source behind every inventory entry that is not build output", async () => {
    const [inventory, rules] = await Promise.all([packagedInventory(), windowsStagingRules()]);
    const checked = [];
    const missing = [];
    for (const file of inventory) {
      const source = checkedInSource(stagedSource(file, rules)[0]);
      if (!source) continue;
      checked.push(source);
      try { await access(repoFile(source)); } catch { missing.push(`${file} <- ${source}`); }
    }
    // A renamed or deleted server module fails here, not only on a Windows run.
    expect(missing, "packaged resources whose source no longer exists").toEqual([]);
    expect(checked).toContain("server/windows-file-privacy.ts");
    expect(checked).toContain("server/hermes-profile-storage.ts");
  });
});
