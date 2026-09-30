#!/usr/bin/env node
// Renders build/dmg-background.html to build/dmg-background.png (660x420) and
// build/dmg-background@2x.png (1320x840) with headless Chrome. electron-builder
// combines the pair into the DMG window background.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = pathToFileURL(join(root, "build", "dmg-background.html")).href;
const chrome = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (!existsSync(chrome)) throw new Error(`Chrome not found at ${chrome}; set CHROME_BIN.`);

for (const [scale, name] of [[1, "dmg-background.png"], [2, "dmg-background@2x.png"]]) {
  execFileSync(chrome, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--default-background-color=00000000",
    `--force-device-scale-factor=${scale}`, "--window-size=660,420",
    `--screenshot=${join(root, "build", name)}`, source,
  ], { stdio: "ignore" });
  console.log(`[render-dmg-background] build/${name}`);
}
