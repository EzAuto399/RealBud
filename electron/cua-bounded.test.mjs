import { createRequire } from "node:module";
import fs, { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { createCuaConnectionStore } = require("./cua-connection.cjs");

describe("bounded Cua descriptor persistence", () => {
  it("stores native-policy evidence without broad desktop tools", () => {
    const userData = mkdtempSync(path.join(os.tmpdir(), "realbud-cua-bounded-"));
    try {
      const store = createCuaConnectionStore({
        getUserData: () => userData,
        fileSystem: fs,
        temporaryId: () => "test",
        processId: 9,
      });
      store.persist({ mode: "embedded", mcpCommand: "/app/cua-driver", mcpArgs: ["mcp"] });
      const bounded = {
        kind: "workflow",
        driverVersion: "0.19.3",
        policyVersion: 2,
        mode: "bounded",
        profileKind: "isolated",
        origins: ["http://127.0.0.1:9"],
        tools: ["browser_navigate", "get_browser_state", "browser_click", "browser_type"],
        policySha256: "a".repeat(64),
        expiresAt: Date.now() + 60_000,
        idleTimeoutMs: 120_000,
        workItemId: "work-1",
        recipeId: "fake-building-portal",
        recipeVersion: 1,
      };
      const next = store.persist({ ...store.get(), bounded });
      expect(next.bounded.driverVersion).toBe("0.19.3");
      expect(next.bounded.tools).not.toContain("get_desktop_state");
      expect(JSON.parse(fs.readFileSync(path.join(userData, "cua-connection.json"), "utf8")).bounded.workItemId).toBe(
        "work-1",
      );
    } finally {
      rmSync(userData, { recursive: true, force: true });
    }
  });
});
