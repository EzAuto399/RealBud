import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { pilotContractMissingFields } from "../server/pilot-contract.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2];
if (target !== "mac" && target !== "win") {
  throw new Error("usage: release-preflight.mjs <mac|win>");
}

const failures = [];
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (!Number.isInteger(nodeMajor) || nodeMajor < 24) failures.push("Node 24 or newer is required");

for (const field of pilotContractMissingFields()) failures.push(`pilot contract: ${field}`);
if (process.env.REALBUD_RELEASE_ACK !== "pilot-reviewed") {
  failures.push("REALBUD_RELEASE_ACK must be pilot-reviewed");
}

try {
  const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (dirty.trim()) failures.push("the release checkout must be clean");
} catch {
  failures.push("the release checkout could not be verified");
}

if (target === "mac") {
  if (process.platform !== "darwin") failures.push("macOS releases must be built on macOS");
  if (!process.env.CSC_LINK && !process.env.CSC_NAME) {
    failures.push("a Developer ID Application signing identity is required (CSC_LINK or CSC_NAME)");
  }
  const apiAuth = process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER;
  const idAuth = process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID;
  const keychainAuth = process.env.APPLE_KEYCHAIN_PROFILE;
  if (!apiAuth && !idAuth && !keychainAuth) failures.push("Apple notarization credentials are required");
}

if (target === "win") {
  if (process.platform !== "win32") failures.push("Windows releases must be built on Windows");
  if (!process.env.WIN_CSC_LINK) failures.push("a Windows code-signing certificate is required (WIN_CSC_LINK)");
  if (!process.env.WIN_CSC_KEY_PASSWORD) failures.push("the Windows certificate password is required");
}

if (failures.length) {
  console.error(`[release-preflight] BLOCKED\n${failures.map((item) => `- ${item}`).join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`[release-preflight] OK: ${target} pilot, checkout, runtime, signing, and notarization gates are present`);
}
