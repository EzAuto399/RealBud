import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
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
    // Compact macOS grid: 824 tile inside 1024. Raster corners must stay
    // transparent or the Dock shows a white plate around the rounded tile.
    expect(buildIcon).toMatch(/translate\(100 100\) scale\(/);
    expect(pngCornerAlphas(readFileSync(join(ROOT, "build", "icon-1024.png")))).toEqual([0, 0, 0, 0]);
  });
});

function pngCornerAlphas(buf: Buffer): number[] {
  if (!buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error("not a PNG");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bit = 0;
  let color = 0;
  const idat: Buffer[] = [];
  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bit = data[8]!;
      color = data[9]!;
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  if (bit !== 8 || color !== 6) throw new Error(`need 8-bit RGBA PNG, got ${bit}/${color}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const first = Buffer.alloc(stride);
  const prev = Buffer.alloc(stride);
  let src = 0;
  let last = first;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++]!;
    const dest = y === 0 ? first : Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const left = i >= 4 ? dest[i - 4]! : 0;
      const up = prev[i]!;
      const upLeft = i >= 4 ? prev[i - 4]! : 0;
      const sample = raw[src + i]!;
      dest[i] =
        filter === 1
          ? (sample + left) & 255
          : filter === 2
            ? (sample + up) & 255
            : filter === 3
              ? (sample + ((left + up) >> 1)) & 255
              : filter === 4
                ? (sample + paethPredictor(left, up, upLeft)) & 255
                : sample;
    }
    src += stride;
    dest.copy(prev);
    last = dest;
  }
  return [first[3]!, first[stride - 1]!, last[3]!, last[stride - 1]!];
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}
