// The pinned runtime spec and the runtime/ancillary split.
//
// These assertions protect two things that are expensive to get wrong: a hash
// that no longer matches the published archive (build fails, or worse is
// bypassed), and ancillary vendor tooling leaking into every customer download.
import { describe, expect, it } from "vitest";

import {
  POSTGRES_ARTIFACTS,
  RUNTIME_TOP_LEVEL,
  artifactFor,
  artifactKey,
  findLicenceEntry,
  isExcludedFromRuntime,
  isRuntimeEntry,
  requiredExecutables,
  shouldExtract,
} from "../scripts/postgres-artifacts.mjs";

describe("pinned PostgreSQL artifacts", () => {
  it("pins a runtime for exactly the two platforms the office targets", () => {
    expect(Object.keys(POSTGRES_ARTIFACTS).sort()).toEqual(["darwin-arm64", "win32-x64"]);
  });

  it("requires arm64 on macOS so a silent Rosetta fallback cannot ship", () => {
    expect(POSTGRES_ARTIFACTS['darwin-arm64']?.architectures).toContain("arm64");
  });

  it("carries a full SHA-256 and a byte count for every artifact", () => {
    for (const [key, artifact] of Object.entries(POSTGRES_ARTIFACTS)) {
      expect(artifact.sha256, key).toMatch(/^[a-f0-9]{64}$/);
      expect(artifact.bytes, key).toBeGreaterThan(100_000_000);
      expect(artifact.url, key).toMatch(/^https:\/\//);
    }
  });

  it("resolves by platform and architecture, and refuses anything else", () => {
    expect(artifactKey("darwin", "arm64")).toBe("darwin-arm64");
    expect(artifactFor("darwin", "arm64")?.file).toMatch(/osx-binaries\.zip$/);
    expect(artifactFor("win32", "x64")?.file).toMatch(/windows-x64-binaries\.zip$/);
    // Intel Macs and Windows ARM are not admission targets.
    expect(artifactFor("darwin", "x64")).toBeNull();
    expect(artifactFor("win32", "arm64")).toBeNull();
    expect(artifactFor("linux", "x64")).toBeNull();
  });
});

describe("runtime versus vendor tooling", () => {
  it("keeps the three server directories", () => {
    expect(RUNTIME_TOP_LEVEL).toEqual(["bin", "lib", "share"]);
    for (const directory of RUNTIME_TOP_LEVEL) {
      expect(isRuntimeEntry(`pgsql/${directory}/something`)).toBe(true);
    }
  });

  it("drops pgAdmin, Stack Builder, headers and docs however they are cased", () => {
    // The archive ships `stackbuilder.app` lowercase and `pgAdmin 4.app`.
    for (const entry of [
      "pgsql/pgAdmin 4.app/Contents/MacOS/pgAdmin",
      "pgsql/pgAdmin 4/README",
      "pgsql/stackbuilder.app/Contents/Info.plist",
      "pgsql/StackBuilder/x",
      "pgsql/include/server/postgres.h",
      "pgsql/doc/html/index.html",
      "pgsql/pgAdmin_license.txt",
    ]) {
      expect(isRuntimeEntry(entry), entry).toBe(false);
      expect(isExcludedFromRuntime(entry), entry).toBe(true);
    }
  });

  it("keeps the licence and notice files, which must travel with the runtime", () => {
    for (const entry of ["pgsql/server_license.txt", "pgsql/COPYRIGHT", "pgsql/commandlinetools_3rd_party_licenses.txt"]) {
      expect(isRuntimeEntry(entry), entry).toBe(true);
    }
  });

  it("keeps run-time data that initdb cannot work without", () => {
    expect(isRuntimeEntry("pgsql/share/postgresql/postgres.bki")).toBe(true);
    expect(isRuntimeEntry("pgsql/lib/libpq.5.dylib")).toBe(true);
  });

  it("ignores directory entries and paths outside the archive root", () => {
    expect(shouldExtract("pgsql/bin/")).toBe(false);
    expect(shouldExtract("other/bin/postgres")).toBe(false);
    expect(shouldExtract("pgsql/bin/postgres")).toBe(true);
  });

  it("finds the licence under either published name", () => {
    expect(findLicenceEntry(["pgsql/bin/x", "pgsql/server_license.txt"])).toBe("pgsql/server_license.txt");
    expect(findLicenceEntry(["pgsql/COPYRIGHT"])).toBe("pgsql/COPYRIGHT");
    expect(findLicenceEntry(["pgsql/bin/x"])).toBeNull();
  });

  it("names the executables for each platform's suffix", () => {
    expect(requiredExecutables("darwin")).toEqual(["pgsql/bin/postgres", "pgsql/bin/initdb", "pgsql/bin/pg_ctl"]);
    expect(requiredExecutables("win32")).toEqual(["pgsql/bin/postgres.exe", "pgsql/bin/initdb.exe", "pgsql/bin/pg_ctl.exe"]);
  });
});
