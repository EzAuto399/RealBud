// One place the app asks "how is the pinned Hermes worker doing?"
// Pure probing — no install, no Hermes Desktop, no source edits. Every
// check is cheap (one --version exec + file reads), so the GUI can ask on
// focus and after a Desk Recheck without a spinner.
import { execFile } from "node:child_process";

import { augmentedPath } from "./env-path.ts";

import { HERMES_PIN, hermesInstallCommand, hermesMatchesPin } from "./hermes-pin.ts";
import { approvalsAreManual, hermesHome, packInstalled, propertyProfileDir, propertyWorkroomReady } from "./hermes-pack.ts";
import type { HandsLast } from "./hands-last.ts";

export interface HermesStatus {
  pin: { product: string; tag: string; commit: string; profile: string };
  cli: { installed: boolean; versionText: string | null; matchesPin: boolean };
  pack: { installed: boolean; approvalsManual: boolean; workroomReady: boolean };
  homeDir: string;
  profileDir: string;
  installCommand: string | null;
  signInCommand: string;
  /** One human sentence: what is missing, or that the hands test passed. */
  detail: string;
  ready: boolean;
}

/** Pin+pack is not ready. Ready means Test hands returned OK. */
export function applyHandsReadiness(status: HermesStatus, lastPing: HandsLast | null): HermesStatus {
  if (
    !status.cli.installed ||
    !status.cli.matchesPin ||
    !status.pack.installed ||
    !status.pack.approvalsManual ||
    !status.pack.workroomReady
  ) {
    return status;
  }
  if (lastPing?.kind === "ping" && lastPing.ok) {
    return {
      ...status,
      ready: true,
      detail: `Worker ${HERMES_PIN.product} passed the hands test. Desk Recheck can ask it for the morning ledger.`,
    };
  }
  return {
    ...status,
    ready: false,
    detail: `Worker ${HERMES_PIN.product} and the pack are installed. Run the hands test before Recheck or Ask.`,
  };
}

// The version string only changes when the worker is reinstalled, so a short
// cache keeps focus refetches and status polls from spawning a process per call.
const VERSION_CACHE_MS = 60_000;
let versionCache: { cli: string; at: number; text: string | null } | null = null;

export function clearHermesVersionCache(): void {
  versionCache = null;
}

export function probeHermesVersion(cli: string): Promise<string | null> {
  if (!process.env.VITEST && versionCache && versionCache.cli === cli && Date.now() - versionCache.at < VERSION_CACHE_MS) {
    return Promise.resolve(versionCache.text);
  }
  return new Promise((resolve) => {
    // Finder-launched apps inherit a stub PATH; the worker lives in
    // ~/.local/bin or Homebrew, so probes use the augmented login PATH.
    execFile(cli, ["--version"], { timeout: 8_000, env: { ...process.env, PATH: augmentedPath() } }, (err, stdout) => {
      const text = err ? null : String(stdout);
      versionCache = { cli, at: Date.now(), text };
      resolve(text);
    });
  });
}

export async function hermesStatus(
  opts?: { root?: string; cli?: string; platform?: NodeJS.Platform },
): Promise<HermesStatus> {
  const platform = opts?.platform ?? process.platform;
  const cli = opts?.cli ?? "hermes";
  const versionText = await probeHermesVersion(cli);
  const matchesPin = versionText != null && hermesMatchesPin(versionText);
  const pack = {
    installed: packInstalled(opts?.root),
    approvalsManual: approvalsAreManual(opts?.root),
    workroomReady: propertyWorkroomReady(opts?.root),
  };

  let detail: string;
  let ready: boolean;
  if (!versionText) {
    detail = `The worker is not installed — install the pinned v${HERMES_PIN.product} worker, then run the install.`;
    ready = false;
  } else if (!matchesPin) {
    detail = `Installed worker is ${versionText.trim()} but the pin is v${HERMES_PIN.product} (${HERMES_PIN.tag}). Install the pinned worker.`;
    ready = false;
  } else if (!pack.installed) {
    detail = `Worker ${HERMES_PIN.product} matches the pin, but the "${HERMES_PIN.profile}" pack is not installed. Apply the property pack.`;
    ready = false;
  } else if (!pack.approvalsManual) {
    detail = `Worker ${HERMES_PIN.product} and the pack are in, but approvals are not manual on the "${HERMES_PIN.profile}" profile. Re-apply the pack.`;
    ready = false;
  } else if (!pack.workroomReady) {
    detail = `Worker ${HERMES_PIN.product} needs the current private workroom policy. Re-apply the property pack.`;
    ready = false;
  } else {
    detail = `Worker ${HERMES_PIN.product} and the pack are installed. Run the hands test before Recheck or Ask.`;
    ready = false;
  }

  return {
    pin: { ...HERMES_PIN },
    cli: { installed: versionText != null, versionText, matchesPin },
    pack,
    homeDir: hermesHome(opts?.root),
    profileDir: propertyProfileDir(opts?.root),
    installCommand: hermesInstallCommand(platform),
    signInCommand: `hermes -p ${HERMES_PIN.profile} model`,
    detail,
    ready,
  };
}
