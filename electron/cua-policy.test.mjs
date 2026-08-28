import { createRequire } from "node:module";
import fs, { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  CUA_PIN,
  TYPED_BROWSER_TOOLS,
  createBrowserPolicy,
  createSetupPolicy,
  normalizeOrigin,
  persistPolicy,
  removePolicy,
  serializePolicy,
} = require("./cua-policy.cjs");

describe("Cua native capability policies", () => {
  it("builds the pinned 0.19.3 origin-scoped typed-browser-only version 2 policy", () => {
    const policy = createBrowserPolicy({
      origins: ["https://bank.example"],
      profileKind: "isolated",
      ttlSeconds: 900,
      idleSeconds: 120,
      workItemId: "work-1",
      recipeId: "bank-credit-list",
      recipeVersion: 1,
    });
    expect(CUA_PIN).toBe("0.19.3");
    expect(policy).toMatchObject({
      version: 2,
      mode: "bounded",
      expires_after: "900s",
      idle_timeout: "120s",
      resources: {
        browser: { profiles: [{ kind: "isolated" }], origins: ["https://bank.example"] },
        desktop: { display: false },
      },
    });
    expect(policy.allow.tools).toEqual(TYPED_BROWSER_TOOLS);
    expect(policy.allow.tools).not.toContain("get_desktop_state");
    expect(policy.allow.tools).not.toContain("list_windows");
    expect(policy.allow.tools).not.toContain("get_window_state");
    expect(policy.allow.tools).not.toContain("click");
    expect(policy.allow.tools).not.toContain("page");
    const yaml = serializePolicy(policy);
    expect(yaml).toContain('version: 2');
    expect(yaml).toContain('mode: "bounded"');
    expect(yaml).toContain('- "browser_navigate"');
    expect(yaml).toContain('- "https://bank.example"');
    expect(yaml).toContain("display: false");
  });

  it("uses a setup-only policy before a case-bound workflow exists", () => {
    const policy = createSetupPolicy();
    expect(policy.allow.tools).toEqual(["check_permissions"]);
    expect(policy.resources.desktop.display).toBe(false);
    expect(serializePolicy(policy)).not.toContain("browser:");
  });

  it("rejects paths, credentials, insecure remote origins and loopback lookalikes", () => {
    for (const origin of [
      "https://bank.example/login",
      "https://person:secret@bank.example",
      "http://bank.example",
      "http://127.0.0.1.evil.example:9000",
      "not a URL",
    ]) {
      expect(() => normalizeOrigin(origin, { allowLoopbackHttp: true })).toThrow();
    }
    expect(normalizeOrigin("http://127.0.0.1:9000", { allowLoopbackHttp: true })).toBe(
      "http://127.0.0.1:9000",
    );
  });

  it("rejects unsafe profile, expiry, duplicate origin and identifier input", () => {
    const base = {
      origins: ["https://bank.example"],
      profileKind: "isolated",
      ttlSeconds: 900,
      idleSeconds: 120,
      workItemId: "work-1",
      recipeId: "bank-credit-list",
      recipeVersion: 1,
    };
    expect(() => createBrowserPolicy({ ...base, profileKind: "existing_profile" })).toThrow(/isolated/);
    expect(() => createBrowserPolicy({ ...base, ttlSeconds: 30 })).toThrow(/lifetime/);
    expect(() => createBrowserPolicy({ ...base, idleSeconds: 901 })).toThrow(/idle/);
    expect(() => createBrowserPolicy({ ...base, origins: [base.origins[0], base.origins[0]] })).toThrow(/unique/);
    expect(() => createBrowserPolicy({ ...base, workItemId: "../escape" })).toThrow(/work item/);
  });

  it("persists a private atomic policy and removes only an owned exact file", () => {
    const userData = mkdtempSync(path.join(os.tmpdir(), "realbud-cua-policy-"));
    try {
      const saved = persistPolicy({ userData, label: "setup", policy: createSetupPolicy(), processId: 7 });
      expect(saved.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(readFileSync(saved.path, "utf8")).toBe(saved.body);
      expect(statSync(path.dirname(saved.path)).mode & 0o777).toBe(0o700);
      expect(statSync(saved.path).mode & 0o777).toBe(0o600);

      const outside = path.join(userData, "keep.txt");
      writeFileSync(outside, "keep");
      expect(removePolicy({ userData, policyPath: outside })).toBe(false);
      expect(readFileSync(outside, "utf8")).toBe("keep");
      expect(removePolicy({ userData, policyPath: saved.path })).toBe(true);
      expect(fs.existsSync(saved.path)).toBe(false);
    } finally {
      rmSync(userData, { recursive: true, force: true });
    }
  });
});
