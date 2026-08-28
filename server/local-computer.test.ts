import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { ALLOWED_TOOLS } from "./cua-bounded.ts";
import { readCuaConnection } from "./local-computer.ts";

const NOW = 1_000_000;
const TEST_ROOT = mkdtempSync(join(os.tmpdir(), "realbud-local-computer-test-"));
const fixtureDir = (name: string) => join(TEST_ROOT, name);
afterAll(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

function workflowPolicyBody(origin = "https://bank.example", ttlSeconds = 900, idleSeconds = 120): string {
  return [
    "version: 2",
    'mode: "bounded"',
    `expires_after: ${JSON.stringify(`${ttlSeconds}s`)}`,
    `idle_timeout: ${JSON.stringify(`${idleSeconds}s`)}`,
    "",
    "allow:",
    "  tools:",
    ...ALLOWED_TOOLS.map((tool) => `    - ${JSON.stringify(tool)}`),
    "",
    "resources:",
    "  browser:",
    "    profiles:",
    '      - kind: "isolated"',
    "    origins:",
    `      - ${JSON.stringify(origin)}`,
    "  desktop:",
    "    display: false",
    "",
  ].join("\n");
}

function writeWorkflowDescriptor(
  userData: string,
  overrides: Record<string, unknown> = {},
): { descriptorPath: string; policyPath: string; expected: { command: string; args: string[]; env: Record<string, string> } } {
  const policyRoot = join(userData, "cua", "policies");
  mkdirSync(policyRoot, { recursive: true, mode: 0o700 });
  chmodSync(policyRoot, 0o700);
  const policyPath = join(policyRoot, "work-1-test.yaml");
  const body = workflowPolicyBody();
  writeFileSync(policyPath, body, { mode: 0o600 });
  chmodSync(policyPath, 0o600);
  const socketPath = join(userData, "cua.sock");
  const command = join(userData, "cua-driver");
  writeFileSync(command, "fixture driver", { mode: 0o700 });
  chmodSync(command, 0o700);
  const descriptor = {
    mode: "embedded",
    runtime: "bundled",
    socketPath,
    mcpCommand: command,
    mcpArgs: ["mcp", "--embedded", "--socket", socketPath],
    mcpEnv: { CUA_DRIVER_EMBEDDED: "1", CUA_DRIVER_HOST_BUNDLE_ID: "com.realbud.app" },
    authorizationMode: "bounded",
    bounded: {
      kind: "workflow",
      mode: "bounded",
      driverVersion: "0.19.3",
      policyVersion: 2,
      policyPath,
      policySha256: createHash("sha256").update(body).digest("hex"),
      profileKind: "isolated",
      origins: ["https://bank.example"],
      tools: [...ALLOWED_TOOLS],
      startedAt: NOW,
      expiresAt: NOW + 900_000,
      idleTimeoutMs: 120_000,
      policyTtlSeconds: 900,
      policyIdleSeconds: 120,
      workItemId: "work-1",
      recipeId: "bank-credit-list",
      recipeVersion: 1,
    },
    ...overrides,
  };
  const descriptorPath = join(userData, "cua-connection.json");
  writeFileSync(descriptorPath, JSON.stringify(descriptor), { mode: 0o600 });
  chmodSync(descriptorPath, 0o600);
  return {
    descriptorPath,
    policyPath,
    expected: { command, args: descriptor.mcpArgs, env: descriptor.mcpEnv },
  };
}

describe("local computer descriptor", () => {
  it("returns only an exact live native-bounded workflow descriptor on macOS", () => {
    const userData = fixtureDir("bounded-user-data");
    const fixture = writeWorkflowDescriptor(userData);
    expect(readCuaConnection({
      platform: "darwin",
      userData,
      expectedDriver: fixture.expected.command,
      now: NOW + 1_000,
    })).toEqual(fixture.expected);
  });

  it("fails closed on Linux and Windows even when a bounded descriptor exists", () => {
    const userData = fixtureDir("unsupported-user-data");
    writeWorkflowDescriptor(userData);
    expect(readCuaConnection({ platform: "linux", userData, now: NOW + 1_000 })).toBeNull();
    expect(readCuaConnection({ platform: "win32", userData, now: NOW + 1_000 })).toBeNull();
  });

  it("rejects a setup-only, standard, stale, wrong-version, or widened descriptor", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["setup", { bounded: { kind: "setup" } }],
      ["standard", { authorizationMode: "standard" }],
      ["stale", {}],
      ["wrong-version", {}],
      ["widened", {}],
      ["extra-field", { unexpected: true }],
    ];
    for (const [name, topLevel] of cases) {
      const userData = fixtureDir(`rejected-${name}`);
      const fixture = writeWorkflowDescriptor(userData, topLevel);
      if (name === "stale") {
        expect(readCuaConnection({ platform: "darwin", userData, now: NOW + 900_001 })).toBeNull();
        continue;
      }
      if (name === "wrong-version" || name === "widened") {
        const raw = JSON.parse(readFileSync(fixture.descriptorPath, "utf8"));
        if (name === "wrong-version") raw.bounded.driverVersion = "0.19.30";
        else raw.bounded.tools.push("get_desktop_state");
        writeFileSync(fixture.descriptorPath, JSON.stringify(raw));
      }
      expect(readCuaConnection({ platform: "darwin", userData, now: NOW + 1_000 })).toBeNull();
    }
  });

  it("rejects tampered or symlinked policy files and policy paths outside RealBud", () => {
    const tamperedData = fixtureDir("tampered-policy-user-data");
    const tampered = writeWorkflowDescriptor(tamperedData);
    writeFileSync(tampered.policyPath, `${workflowPolicyBody()}# widened`);
    expect(readCuaConnection({ platform: "darwin", userData: tamperedData, now: NOW + 1_000 })).toBeNull();

    const symlinkData = fixtureDir("symlink-policy-user-data");
    const symlinked = writeWorkflowDescriptor(symlinkData);
    const target = join(symlinkData, "outside.yaml");
    writeFileSync(target, workflowPolicyBody());
    unlinkSync(symlinked.policyPath);
    symlinkSync(target, symlinked.policyPath);
    expect(readCuaConnection({ platform: "darwin", userData: symlinkData, now: NOW + 1_000 })).toBeNull();

    const outsideData = fixtureDir("outside-policy-user-data");
    const outside = writeWorkflowDescriptor(outsideData);
    const raw = JSON.parse(readFileSync(outside.descriptorPath, "utf8"));
    raw.bounded.policyPath = join(outsideData, "outside.yaml");
    writeFileSync(raw.bounded.policyPath, workflowPolicyBody());
    raw.bounded.policySha256 = createHash("sha256").update(workflowPolicyBody()).digest("hex");
    writeFileSync(outside.descriptorPath, JSON.stringify(raw));
    expect(readCuaConnection({ platform: "darwin", userData: outsideData, now: NOW + 1_000 })).toBeNull();
  });

  it("rejects injected MCP arguments, non-absolute commands, malformed env and symlinked descriptors", () => {
    const argumentData = fixtureDir("injected-args-user-data");
    writeWorkflowDescriptor(argumentData, { mcpArgs: ["mcp", "--direct"] });
    expect(readCuaConnection({ platform: "darwin", userData: argumentData, now: NOW + 1_000 })).toBeNull();

    const commandData = fixtureDir("relative-command-user-data");
    writeWorkflowDescriptor(commandData, { mcpCommand: "cua-driver" });
    expect(readCuaConnection({ platform: "darwin", userData: commandData, now: NOW + 1_000 })).toBeNull();

    const redirectedData = fixtureDir("redirected-command-user-data");
    const redirected = writeWorkflowDescriptor(redirectedData);
    const rogueRoot = join(redirectedData, "rogue");
    const rogue = join(rogueRoot, "cua-driver");
    mkdirSync(rogueRoot);
    writeFileSync(rogue, "rogue driver", { mode: 0o700 });
    const redirectedRaw = JSON.parse(readFileSync(redirected.descriptorPath, "utf8"));
    redirectedRaw.mcpCommand = rogue;
    writeFileSync(redirected.descriptorPath, JSON.stringify(redirectedRaw), { mode: 0o600 });
    expect(readCuaConnection({
      platform: "darwin",
      userData: redirectedData,
      expectedDriver: redirected.expected.command,
      now: NOW + 1_000,
    })).toBeNull();

    const envData = fixtureDir("array-env-user-data");
    writeWorkflowDescriptor(envData, { mcpEnv: ["CUA_DRIVER_EMBEDDED=1"] });
    expect(readCuaConnection({ platform: "darwin", userData: envData, now: NOW + 1_000 })).toBeNull();

    const injectedEnvData = fixtureDir("injected-env-user-data");
    writeWorkflowDescriptor(injectedEnvData, {
      mcpEnv: {
        CUA_DRIVER_EMBEDDED: "1",
        CUA_DRIVER_HOST_BUNDLE_ID: "com.realbud.app",
        DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib",
      },
    });
    expect(readCuaConnection({ platform: "darwin", userData: injectedEnvData, now: NOW + 1_000 })).toBeNull();

    const symlinkData = fixtureDir("symlink-descriptor-user-data");
    const symlink = writeWorkflowDescriptor(symlinkData);
    const descriptorTarget = join(symlinkData, "descriptor-target.json");
    renameSync(symlink.descriptorPath, descriptorTarget);
    symlinkSync(descriptorTarget, symlink.descriptorPath);
    expect(readCuaConnection({ platform: "darwin", userData: symlinkData, now: NOW + 1_000 })).toBeNull();
  });

  it("rejects public descriptors/policies and non-executable drivers", () => {
    const descriptorData = fixtureDir("public-descriptor-user-data");
    const publicDescriptor = writeWorkflowDescriptor(descriptorData);
    chmodSync(publicDescriptor.descriptorPath, 0o644);
    expect(readCuaConnection({ platform: "darwin", userData: descriptorData, now: NOW + 1_000 })).toBeNull();

    const policyData = fixtureDir("public-policy-user-data");
    const publicPolicy = writeWorkflowDescriptor(policyData);
    chmodSync(publicPolicy.policyPath, 0o644);
    expect(readCuaConnection({ platform: "darwin", userData: policyData, now: NOW + 1_000 })).toBeNull();

    const policyRootData = fixtureDir("public-policy-root-user-data");
    writeWorkflowDescriptor(policyRootData);
    chmodSync(join(policyRootData, "cua", "policies"), 0o755);
    expect(readCuaConnection({ platform: "darwin", userData: policyRootData, now: NOW + 1_000 })).toBeNull();

    const driverData = fixtureDir("non-executable-driver-user-data");
    const nonExecutable = writeWorkflowDescriptor(driverData);
    chmodSync(nonExecutable.expected.command, 0o600);
    expect(readCuaConnection({ platform: "darwin", userData: driverData, now: NOW + 1_000 })).toBeNull();
  });
});
