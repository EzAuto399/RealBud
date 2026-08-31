import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("mac package resource graph", () => {
  it("ships every compiled and Hermes resource the packaged server resolves", () => {
    const config = readFileSync(join(ROOT, "electron-builder.yml"), "utf8");
    expect(config).toMatch(/from: dist-server\/server\s+to: server/);
    expect(config).toMatch(/from: dist-server\/shared\s+to: shared/);
    expect(config).toMatch(/from: dist-server\/src\s+to: src/);
    expect(config).toMatch(/from: pack\/property\s+to: pack\/property/);
  });

  it("uses the RealBud product identity and property-agent mark in source and Electron", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { name?: string; productName?: string };
    const main = readFileSync(join(ROOT, "electron", "main.mjs"), "utf8");
    const publicIcon = readFileSync(join(ROOT, "public", "app-icon.svg"), "utf8");
    const buildIcon = readFileSync(join(ROOT, "build", "icon.svg"), "utf8");
    const canonicalMark = readFileSync(join(ROOT, "docs", "brand", "realbud-mark-v1.svg"), "utf8");

    expect(pkg).toMatchObject({ name: "realbud", productName: "RealBud" });
    expect(main).toContain('app.setName("RealBud")');
    expect(main.indexOf('app.setName("RealBud")')).toBeLessThan(main.indexOf("app.whenReady()"));
    for (const svg of [publicIcon, buildIcon, canonicalMark]) {
      expect(svg).toContain('<title id="title">RealBud</title>');
      expect(svg).toContain("bud-green");
      expect(svg).not.toMatch(/OpenMausBot|SupaMaus|mascot-grey/i);
    }
  });
});
