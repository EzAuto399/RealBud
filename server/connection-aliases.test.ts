import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadConnectionAliases, setConnectionAlias } from "./connection-aliases.ts";

describe("connection aliases", () => {
  it("stores a short local name and clears it", () => {
    const dir = mkdtempSync(join(tmpdir(), "realbud-alias-"));
    expect(setConnectionAlias(dir, "property-book", "Oak Agency book")).toEqual({
      "property-book": "Oak Agency book",
    });
    expect(loadConnectionAliases(dir)["property-book"]).toBe("Oak Agency book");
    expect(setConnectionAlias(dir, "property-book", "  ")).toEqual({});
  });

  it("refuses URLs, secrets and unknown connections", () => {
    const dir = mkdtempSync(join(tmpdir(), "realbud-alias-"));
    expect(() => setConnectionAlias(dir, "gmail", "Inbox")).toThrow(/cannot be renamed/);
    expect(() => setConnectionAlias(dir, "property-book", "https://evil.test")).toThrow(/short local name/);
  });
});
