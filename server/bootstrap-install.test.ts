import { afterEach, expect, it, vi } from "vitest";
import { cancelBootstrapInstall, installInFlight, installStatus, startBootstrapInstall, waitForBootstrapStop } from "./hermes-bridge.ts";
import { uninstallWorker } from "./hermes-lifecycle.ts";
import { HERMES_RECOMMENDED } from "./hermes-releases.ts";
import type { runWorkerBootstrap } from "./worker-bootstrap.ts";

// Built from the recommended release rather than a literal: these tests assert
// that verification checks whatever a fresh install is meant to receive, and a
// hardcoded string silently became a test of the wrong release.
const version = `Hermes Agent v${HERMES_RECOMMENDED.product} (${HERMES_RECOMMENDED.tag.slice(1)})`;
const run: typeof runWorkerBootstrap = async options => {
  options.progress("Preparing this computer", 1, 8);
  await options.finalize?.();
};
afterEach(async () => { cancelBootstrapInstall(); await waitForBootstrapStop(); });

it("verifies the installed version and applies safeguards before reporting success", async () => {
  const onSuccess = vi.fn();
  // No `release` argument: the default must be the recommended release, not the
  // compatibility floor, or a caller that forgets the argument installs 0.20.3.
  startBootstrapInstall({ run, verify: async () => version, onSuccess });
  await waitForBootstrapStop();
  expect(onSuccess).toHaveBeenCalledOnce();
  expect(installStatus()).toMatchObject({ state: "done", error: null, progress: { step: 1, total: 8 } });
});

it("does not accept the compatibility floor when the recommended release was installed", async () => {
  // Guards the specific regression: verification must not fall back to the pin.
  const onSuccess = vi.fn();
  startBootstrapInstall({ run, verify: async () => "Hermes Agent v0.20.3 (2026.8.16.2)", onSuccess });
  await waitForBootstrapStop();
  expect(installStatus()).toMatchObject({ state: "failed" });
  expect(onSuccess).not.toHaveBeenCalled();
});

it("refuses a mismatched version without applying the property profile", async () => {
  const onSuccess = vi.fn();
  startBootstrapInstall({ run, verify: async () => "unreviewed version", onSuccess });
  await waitForBootstrapStop();
  expect(installStatus()).toMatchObject({ state: "failed", error: expect.stringMatching(/verify its installed version/) });
  expect(onSuccess).not.toHaveBeenCalled();
});

it("does not expose filesystem paths or credential-shaped errors from profile setup", async () => {
  startBootstrapInstall({ run, verify: async () => version, onSuccess: () => { throw new Error("/private/user/secret-token"); } });
  await waitForBootstrapStop();
  expect(installStatus().error).toMatch(/private property setup/);
  expect(JSON.stringify(installStatus())).not.toContain("secret-token");
});

it("deduplicates setup, cancels it, and allows retry after it has stopped", async () => {
  const waiting = vi.fn<typeof runWorkerBootstrap>(async options => {
    await new Promise<void>(resolve => options.signal.addEventListener("abort", () => resolve(), { once: true }));
    options.signal.throwIfAborted();
  });
  startBootstrapInstall({ run: waiting });
  const started = installStatus().startedAt;
  expect(startBootstrapInstall({ run: waiting }).startedAt).toBe(started);
  expect(waiting).toHaveBeenCalledOnce();
  expect(installInFlight()).toBe(true);
  await expect(uninstallWorker()).rejects.toMatchObject({ status: 409 });
  cancelBootstrapInstall();
  await waitForBootstrapStop();
  expect(installStatus()).toMatchObject({ state: "failed", error: expect.stringMatching(/Setup stopped/) });
  startBootstrapInstall({ run, verify: async () => version });
  await waitForBootstrapStop();
  expect(installStatus().state).toBe("done");
});

it("times out a stalled installer and never claims completion", async () => {
  startBootstrapInstall({ timeoutMs: 10, run: async options => {
    await new Promise<void>(resolve => options.signal.addEventListener("abort", () => resolve(), { once: true }));
  } });
  await waitForBootstrapStop();
  expect(installStatus().state).toBe("failed");
  expect(installInFlight()).toBe(false);
});

it("cancellation during verification remains incomplete", async () => {
  startBootstrapInstall({ run, verify: async () => { cancelBootstrapInstall(); return version; } });
  await waitForBootstrapStop();
  expect(installStatus().state).toBe("failed");
});
