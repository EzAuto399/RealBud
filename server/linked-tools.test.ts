import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { saveConfig } from "./config.ts";
import { hasLinkedToolKey, listLinkedTools, removeLinkedTool, saveLinkedComposioTool, saveLinkedToolKey, saveLinkedToolPeek } from "./linked-tools.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("linked tools", () => {
  it("stores a key on device and lists it without echoing the secret", () => {
    const dir = mkdtempSync(join(tmpdir(), "realbud-linked-"));
    dirs.push(dir);
    const opts = { dir };
    const saved = saveLinkedToolKey({ slug: "notion", label: "Notion", key: "ntn_g9538deadbeef99" }, opts);
    expect(saved).toEqual({ slug: "notion", label: "Notion", method: "direct-api", connected: true });
    expect(hasLinkedToolKey("notion", opts)).toBe(true);
    expect(JSON.stringify(listLinkedTools(opts))).not.toContain("ntn_");
    expect(listLinkedTools(opts)).toEqual([
      { slug: "notion", label: "Notion", method: "direct-api", connected: true },
    ]);
    saveLinkedToolPeek("notion", ["Getting Started", "Arrears board"], opts);
    expect(listLinkedTools(opts)).toEqual([
      { slug: "notion", label: "Notion", method: "direct-api", connected: true, lastPeekTitles: ["Getting Started", "Arrears board"] },
    ]);
    expect(JSON.stringify(listLinkedTools(opts))).not.toContain("ntn_");
    removeLinkedTool("notion", opts);
    expect(listLinkedTools(opts)).toEqual([]);
  });

  it("rejects an unsafe slug", () => {
    const dir = mkdtempSync(join(tmpdir(), "realbud-linked-"));
    dirs.push(dir);
    expect(() => saveLinkedToolKey({ slug: "../etc", key: "ntn_g9538deadbeef99" }, { dir })).toThrow(/not usable/i);
  });

  it("lists a Composio-signed app without a per-app key", () => {
    const dir = mkdtempSync(join(tmpdir(), "realbud-linked-"));
    dirs.push(dir);
    const opts = { dir };
    saveConfig({ composio: { key: "ck_qaonlydeadbeef88" } }, opts);
    expect(saveLinkedComposioTool({ slug: "gmail", label: "Gmail", account: "pm@example.com" }, opts)).toEqual({
      slug: "gmail",
      label: "Gmail",
      method: "composio",
      connected: true,
      account: "pm@example.com",
    });
    expect(hasLinkedToolKey("gmail", opts)).toBe(false);
    expect(listLinkedTools(opts)).toEqual([
      { slug: "gmail", label: "Gmail", method: "composio", connected: true, account: "pm@example.com" },
    ]);
    expect(JSON.stringify(listLinkedTools(opts))).not.toContain("ck_");
  });
});
