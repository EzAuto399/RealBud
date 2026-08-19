// One place the app asks "how is the pinned Hermes worker doing?"
// Pure probing — no install, no Hermes Desktop, no source edits. Every
// check is cheap (one --version exec + file reads), so the GUI can ask on
// focus and after a Desk Recheck without a spinner.
import { execFile } from "node:child_process";

import { HERMES_PIN, hermesInstallCommand, hermesMatchesPin } from "./hermes-pin.ts";
import { approvalsAreManual, hermesHome, packInstalled, propertyProfileDir } from "./hermes-pack.ts";

export interface HermesStatus {
  pin: { product: string; tag: string; commit: string; profile: string };
  cli: { installed: boolean; versionText: string | null; matchesPin: boolean };
  pack: { installed: boolean; approvalsManual: boolean };
  homeDir: string;
  profileDir: string;
  installCommand: string | null;
  signInCommand: string;
  /** One human sentence: what is wrong, or that the worker is answering. */
  detail: string;
  ready: boolean;
}

export function probeHermesVersion(cli: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cli, ["--version"], { timeout: 8_000 }, (err, stdout) => {
      resolve(err ? null : String(stdout));
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
  };

  let detail: string;
  let ready: boolean;
  if (!versionText) {
    detail = `Hermes is not installed — install the pinned v${HERMES_PIN.product} worker, then run the install.`;
    ready = false;
  } else if (!matchesPin) {
    detail = `Installed Hermes is ${versionText.trim()} but the pin is v${HERMES_PIN.product} (${HERMES_PIN.tag}). Install the pinned worker.`;
    ready = false;
  } else if (!pack.installed) {
    detail = `Hermes ${HERMES_PIN.product} matches the pin, but the "${HERMES_PIN.profile}" pack is not installed. Apply the property pack.`;
    ready = false;
  } else if (!pack.approvalsManual) {
    detail = `Hermes ${HERMES_PIN.product} and the pack are in, but approvals are not manual on the "${HERMES_PIN.profile}" profile. Re-apply the pack.`;
    ready = false;
  } else {
    detail = `Hermes ${HERMES_PIN.product} answering on profile "${HERMES_PIN.profile}". Desk Recheck will ask it for the morning ledger.`;
    ready = true;
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
