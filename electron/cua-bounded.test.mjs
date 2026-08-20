import { createRequire } from "node:module";
import fs, { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { createCuaConnectionStore } = require("./cua-connection.cjs");

describe("bounded Cua persistence", () => {
  it("stores typed-browser manifest fields and refuses forbidden tools", () => {
    const userData = mkdtempSync(path.join(os.tmpdir(), "realbud-cua-bounded-"));
    try {
      const store = createCuaConnectionStore({
        getUserData: () => userData,
        fileSystem: fs,
        temporaryId: () => "test",
        processId: 9,
      });
      store.persist({ mode: "standalone", mcpCommand: "cua-driver", mcpArgs: ["mcp"] });
      const bounded = {
        version: "0.19.3",
        mode: "bounded",
        profile: path.join(userData, "chrome-profile"),
        origins: ["http://127.0.0.1:9"],
        tools: ["navigate", "read", "fill", "click_semantic"],
        forbidden: ["screenshot_desktop", "click_xy", "javascript", "shell"],
        expiresAt: Date.now() + 60_000,
        idleTimeoutMs: 120_000,
        workItemId: "work-1",
        recipeId: "fake-building-portal",
        recipeVersion: 1,
      };
      const next = store.persist({ ...store.get(), bounded });
      expect(next.bounded.version).toBe("0.19.3");
      expect(next.bounded.tools).not.toContain("click_xy");
      expect(JSON.parse(fs.readFileSync(path.join(userData, "cua-connection.json"), "utf8")).bounded.workItemId).toBe(
        "work-1",
      );
    } finally {
      rmSync(userData, { recursive: true, force: true });
    }
  });
});
