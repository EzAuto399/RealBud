// One place the app asks "how is the pinned Hermes worker doing?"
// Pure probing — no install, no Hermes Desktop, no source edits. Every
// check is cheap (one --version exec + file reads), so the GUI can ask on
// focus and after a Desk Recheck without a spinner.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { augmentedPath } from "./env-path.ts";
import {
  applyWorkerRuntimeEnv,
  WORKER_CLI,
  workerCli as workerCliForRoot,
  workerCliForRuntime,
  workerInstallDirForRuntime,
  workerRuntimeDir,
} from "./config.ts";

import { HERMES_PIN, hermesInstallCommand, hermesMatchesPin } from "./hermes-pin.ts";
import { approvalsAreManual, hermesHome, packInstalled, propertyProfileDir } from "./hermes-pack.ts";

export interface HermesStatus {
  pin: { product: string; tag: string; commit: string; profile: string };
  cli: {
    installed: boolean;
    versionText: string | null;
    checkoutCommit: string | null;
    matchesPin: boolean;
    installId: string | null;
  };
  pack: { installed: boolean; approvalsManual: boolean };
  homeDir: string;
  profileDir: string;
  installCommand: string | null;
  signInCommand: string;
  /** One human sentence: what is wrong, or that the worker is answering. */
  detail: string;
  ready: boolean;
}

export function probeHermesVersion(cli: string, opts?: { root?: string; runtimeDir?: string }): Promise<string | null> {
  return new Promise((resolve) => {
    const root = hermesHome(opts?.root);
    execFile(
      cli,
      ["--version"],
      {
        timeout: 8_000,
        env: applyWorkerRuntimeEnv({ ...process.env }, root, augmentedPath(), opts?.runtimeDir ?? workerRuntimeDir(root)),
      },
      (err, stdout) => resolve(err ? null : String(stdout)),
    );
  });
}

function privateCheckoutCommit(runtime: string): string | null {
  const gitDir = join(workerInstallDirForRuntime(runtime), ".git");
  try {
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    if (/^[0-9a-f]{40}$/i.test(head)) return head.toLowerCase();
    const ref = /^ref:\s+(refs\/[A-Za-z0-9._/-]+)$/.exec(head)?.[1];
    if (!ref || ref.includes("..")) return null;
    try {
      const loose = readFileSync(join(gitDir, ...ref.split("/")), "utf8").trim();
      if (/^[0-9a-f]{40}$/i.test(loose)) return loose.toLowerCase();
    } catch {
      // Fall through to packed refs.
    }
    const packed = readFileSync(join(gitDir, "packed-refs"), "utf8");
    const line = packed.split(/\r?\n/).find((entry) => entry.endsWith(` ${ref}`));
    const commit = line?.split(" ")[0] ?? "";
    return /^[0-9a-f]{40}$/i.test(commit) ? commit.toLowerCase() : null;
  } catch {
    return null;
  }
}

function workerInstallId(
  cli: string,
  versionText: string | null,
  checkoutCommit: string | null,
  runtime: string,
): string | null {
  if (!versionText) return null;
  try {
    const stat = statSync(cli);
    let marker = "";
    try {
      marker = readFileSync(join(runtime, ".realbud-install-id"), "utf8").trim().slice(0, 128);
    } catch {
      // Older private installs fall back to immutable checkout + launcher metadata.
    }
    return createHash("sha256")
      .update(`${checkoutCommit ?? "external"}:${marker}:${stat.dev}:${stat.ino}:${stat.size}:${Math.trunc(stat.mtimeMs)}`)
      .digest("hex")
      .slice(0, 20);
  } catch {
    return null;
  }
}

export async function hermesStatus(
  opts?: { root?: string; cli?: string; runtimeDir?: string; platform?: NodeJS.Platform },
): Promise<HermesStatus> {
  const platform = opts?.platform ?? process.platform;
  const root = hermesHome(opts?.root);
  const runtime = opts?.runtimeDir ?? workerRuntimeDir(root);
  const privateCli = opts?.runtimeDir ? workerCliForRuntime(runtime) : workerCliForRoot(root);
  const cli = opts?.cli ?? (opts?.root ? privateCli : WORKER_CLI);
  const versionText = await probeHermesVersion(cli, { root, runtimeDir: runtime });
  const isPrivateCli = cli === privateCli;
  const checkoutCommit = isPrivateCli ? privateCheckoutCommit(runtime) : null;
  const installId = workerInstallId(cli, versionText, checkoutCommit, runtime);
  const visibleVersion = versionText?.trim().replace(/^Hermes Agent\s*/i, "") ?? null;
  const versionMatches = versionText != null && hermesMatchesPin(versionText);
  const matchesPin = versionMatches && (!isPrivateCli || checkoutCommit === HERMES_PIN.commit);
  const pack = {
    installed: packInstalled(opts?.root),
    approvalsManual: approvalsAreManual(opts?.root),
  };

  let detail: string;
  let ready: boolean;
  if (!versionText) {
    detail = `The worker is not installed — install the pinned v${HERMES_PIN.product} worker, then run the install.`;
    ready = false;
  } else if (versionMatches && isPrivateCli && checkoutCommit !== HERMES_PIN.commit) {
    detail = `The private worker reports v${HERMES_PIN.product}, but its checkout is not RealBud's pinned build. Reinstall the pinned worker.`;
    ready = false;
  } else if (!matchesPin) {
    detail = `Installed worker is ${visibleVersion} but the pin is v${HERMES_PIN.product} (${HERMES_PIN.tag}). Install the pinned worker.`;
    ready = false;
  } else if (!pack.installed) {
    detail = `Worker ${HERMES_PIN.product} matches the pin, but the "${HERMES_PIN.profile}" pack is not installed. Apply the property pack.`;
    ready = false;
  } else if (!pack.approvalsManual) {
    detail = `Worker ${HERMES_PIN.product} and the pack are in, but approvals are not manual on the "${HERMES_PIN.profile}" profile. Re-apply the pack.`;
    ready = false;
  } else {
    detail = `Worker ${HERMES_PIN.product} and the property pack are installed. Run the hands test before Ask.`;
    ready = true;
  }

  return {
    pin: { ...HERMES_PIN },
    cli: { installed: versionText != null, versionText, checkoutCommit, matchesPin, installId },
    pack,
    homeDir: hermesHome(opts?.root),
    profileDir: propertyProfileDir(opts?.root),
    installCommand: hermesInstallCommand(platform),
    signInCommand: `hermes -p ${HERMES_PIN.profile} model`,
    detail,
    ready,
  };
}
