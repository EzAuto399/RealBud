import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("mac package resource graph", () => {
  it("ships every compiled and Hermes resource the packaged server resolves", () => {
    const config = readFileSync(join(ROOT, "electron-builder.yml"), "utf8");
    expect(config).toMatch(/from: dist-server\/server\s+to: server/);
    // Health must report the app version: the server build writes server/app-version.json for app-version.ts.
    // A package.json extraResource breaks electron-builder's app.asar check, so it must not come back.
    expect(config).not.toMatch(/from: package\.json/);
    expect(readFileSync(join(ROOT, "scripts", "bundle-company-deps.mjs"), "utf8")).toContain("'app-version.json'");
    expect(readFileSync(join(ROOT, "server", "app-version.ts"), "utf8")).toContain('"./app-version.json"');
    expect(config).toMatch(/from: dist-server\/shared\s+to: shared/);
    expect(config).toMatch(/from: dist-server\/src\s+to: src/);
    expect(config).toMatch(/from: pack\/property\s+to: pack\/property/);
  });

  // The workflow pack files the server reads at runtime, relative to the compiled server's parent.
  const RUNTIME_PACK_FILES = [
    "pack/workflows/austin-accounts/workflows.json",
    "pack/workflows/austin-accounts/support/LICENSE.upstream",
    "pack/workflows/austin-accounts/support/email-inbox-triage/SKILL.md",
    "pack/workflows/austin-accounts/support/rei-cloud-navigation/SKILL.md",
    "pack/workflows/austin-accounts/support/rei-cloud-navigation/LICENSE",
    "pack/workflows/austin-accounts/support/rei-cloud-navigation/recipes.json",
    "pack/workflows/austin-accounts/support/rei-cloud-navigation/site-map.json",
    "pack/workflows/austin-office/austin-schedule-v1.json",
    "pack/workflows/office-core/realbud-office-core-v1.json",
    "pack/workflows/department-starters/realbud-department-starters-v1.json",
    "pack/workflows/austin-maintenance-rehearsal/realbud-austin-maintenance-rehearsal-v1.json",
  ];

  it("ships every workflow pack the app loads at runtime, in the installer and the Mac test kit", () => {
    // Every pack folder the (non-test) server names must be in the list above.
    const named = new Set<string>();
    for (const file of readdirSync(join(ROOT, "server")).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))) {
      const text = readFileSync(join(ROOT, "server", file), "utf8");
      for (const match of text.matchAll(/pack\/workflows\/([\w-]+)|'pack', 'workflows', '([\w-]+)'|join\(workflows, '([\w-]+)'/g)) named.add(match[1] ?? match[2] ?? match[3]!);
    }
    const listed = new Set(RUNTIME_PACK_FILES.map((file) => file.split("/")[2]!));
    expect([...named].sort()).toEqual([...listed].sort());

    // electron-builder: each file is under an extraResources folder copied to the same path, and passes its filter.
    const config = readFileSync(join(ROOT, "electron-builder.yml"), "utf8");
    const entries = [...config.matchAll(/- from: (\S+)\n\s+to: (\S+)(?:\n\s+filter:\n((?:\s+- .+\n?)+))?/g)]
      .map(([, from, to, filter]) => ({ from: from!, to: to!, filter: filter?.split("\n").map((line) => line.replace(/^\s*- /, "").trim()).filter(Boolean) }));
    for (const file of RUNTIME_PACK_FILES) {
      expect(existsSync(join(ROOT, file)), file).toBe(true);
      const entry = entries.find((row) => file.startsWith(`${row.from}/`));
      expect(entry, `${file} is not in electron-builder.yml extraResources`).toBeDefined();
      expect(entry!.to, file).toBe(entry!.from);
      if (entry!.filter) expect(entry!.filter, file).toContain(file.slice(entry!.from.length + 1));
    }

    // The Mac test kit copies the same packs into its resources.
    const kit = readFileSync(join(ROOT, "scripts", "build-mac-test-kit.mjs"), "utf8");
    const kitFolders = /for \(const name of \[([^\]]+)\]\) await cp\(join\(root, 'pack\/workflows', name\)/.exec(kit)?.[1]?.match(/'[\w-]+'/g)?.map((name) => name.slice(1, -1)) ?? [];
    for (const file of RUNTIME_PACK_FILES) {
      const folder = file.split("/")[2]!;
      expect(kitFolders.includes(folder) || kit.includes(`'${file}'`), `${file} is not in the Mac test kit`).toBe(true);
    }
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
