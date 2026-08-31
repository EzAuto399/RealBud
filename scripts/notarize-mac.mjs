#!/usr/bin/env node
// Notarize + staple a packaged RealBud Mac build (T17).
//
// Preconditions:
//   1. pnpm package:mac  (Developer ID signed .app + .dmg + .zip)
//   2. Keychain profile once:
//        xcrun notarytool store-credentials "realbud-notary" \
//          --apple-id "…" --team-id "4F4SMS88P8" --password "…"
//
//   NOTARY_KEYCHAIN_PROFILE=realbud-notary node scripts/notarize-mac.mjs
//
// Optional:
//   NOTARY_SUBMIT=dmg|zip|app   (default: zip — faster upload than DMG)
//   NOTARY_WAIT=0               skip wait/staple (submit only)
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = path.join(root, "release");
const preferred = process.env.NOTARY_KEYCHAIN_PROFILE || "realbud-notary";
const candidates = [preferred, "ClawConnect", "AC_PASSWORD"].filter(
  (name, i, arr) => arr.indexOf(name) === i,
);
const submitKind = (process.env.NOTARY_SUBMIT || "zip").toLowerCase();
const wait = process.env.NOTARY_WAIT !== "0";

function die(msg) {
  console.error(`[notarize-mac] ${msg}`);
  process.exit(1);
}

function resolveProfile() {
  for (const name of candidates) {
    const r = spawnSync("xcrun", ["notarytool", "history", "--keychain-profile", name], {
      encoding: "utf8",
    });
    const out = `${r.stdout || ""}${r.stderr || ""}`;
    if (r.status === 0) return name;
    if (/Invalid credentials|401/i.test(out)) {
      console.warn(`[notarize-mac] profile "${name}" exists but credentials are invalid`);
    }
  }
  return null;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
  if (r.status !== 0) {
    die(`${cmd} ${args.join(" ")}\n${r.stdout || ""}${r.stderr || ""}`);
  }
  return (r.stdout || "") + (r.stderr || "");
}

const profile = resolveProfile();
if (!profile) {
  die(
    `no working notary keychain profile (tried ${candidates.join(", ")}).\n` +
      `Create one after generating an app-specific password at appleid.apple.com:\n` +
      `  xcrun notarytool store-credentials "realbud-notary" \\\n` +
      `    --apple-id "YOU@EXAMPLE.COM" --team-id "4F4SMS88P8"\n` +
      `(prompts securely for the app-specific password)`,
  );
}

if (!existsSync(releaseDir)) die(`missing ${releaseDir} — run pnpm package:mac first`);

const app = path.join(releaseDir, "mac-arm64", "RealBud.app");
if (!existsSync(app)) die(`missing ${app}`);

const files = readdirSync(releaseDir);
const dmg = files.find((f) => /^RealBud-.*\.dmg$/.test(f) && !f.includes("blockmap"));
const zip = files.find((f) => /^RealBud-.*-arm64\.zip$/.test(f) && !f.includes("blockmap"));

let submitPath;
if (submitKind === "dmg") {
  if (!dmg) die("no RealBud-*.dmg in release/");
  submitPath = path.join(releaseDir, dmg);
} else if (submitKind === "app") {
  submitPath = app;
} else {
  if (!zip) die("no RealBud-*-arm64.zip in release/");
  submitPath = path.join(releaseDir, zip);
}

console.log(`[notarize-mac] profile=${profile}`);
console.log(`[notarize-mac] submit ${submitPath}`);

const submitOut = run("xcrun", [
  "notarytool",
  "submit",
  submitPath,
  "--keychain-profile",
  profile,
  ...(wait ? ["--wait"] : []),
]);
console.log(submitOut);

if (!wait) {
  console.log("[notarize-mac] submitted (NOTARY_WAIT=0) — staple later with --wait");
  process.exit(0);
}

if (!/status:\s*Accepted/i.test(submitOut) && !/Accepted/i.test(submitOut)) {
  // notarytool --wait prints "status: Accepted" on success; still try staple if unclear
  console.warn("[notarize-mac] warning: Accepted not clearly seen in output — attempting staple anyway");
}

console.log(`[notarize-mac] staple ${app}`);
run("xcrun", ["stapler", "staple", app]);
run("xcrun", ["stapler", "validate", app]);

if (dmg) {
  const dmgPath = path.join(releaseDir, dmg);
  console.log(`[notarize-mac] staple ${dmgPath}`);
  try {
    run("xcrun", ["stapler", "staple", dmgPath]);
    run("xcrun", ["stapler", "validate", dmgPath]);
  } catch {
    // DMG staple can fail if the ticket was for the zip; rebuild DMG from stapled .app if needed
    console.warn("[notarize-mac] DMG staple failed — re-run package:mac after stapling .app, or submit the DMG directly (NOTARY_SUBMIT=dmg)");
  }
}

const spctl = execFileSync("/usr/bin/spctl", ["--assess", "--type", "execute", "-vv", app], {
  encoding: "utf8",
}).trim();
console.log(spctl);
console.log("[notarize-mac] OK — stapled RealBud.app");
