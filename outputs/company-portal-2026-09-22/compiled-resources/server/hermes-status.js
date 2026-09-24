import { currentWorkerProfile } from "./hermes-profile.js";
import { bootstrapPending } from "./worker-bootstrap.js";
// Read-only worker checks. Hermes is independently installed; RealBud owns
// the supported adapter contract and its private property profile.
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { augmentedPath } from "./env-path.js";
import { execCli } from "./procs.js";
import { HERMES_PIN, HERMES_COMPATIBLE_RELEASES, hermesCli, hermesInstallCommand, hermesMatchesPin, hermesIsCompatible, parseHermesVersion } from "./hermes-pin.js";
import { approvalsAreManual, hermesHome, packInstalled, propertyProfileDir, propertyWorkroomReady } from "./hermes-pack.js";
import { readRuntimeSelection } from "./hermes-runtime-selection.js";
export function workerSetupPending(root) {
    return !readRuntimeSelection(hermesHome(root)).selected && bootstrapPending(hermesHome(root));
}
/** Product-facing name for the Hermes `property` profile — never rename the pin. */
export const BUD_HANDS_LABEL = "Bud's hands";
/** A passing check belongs to this worker and profile, never an earlier setup.
 * Only the digest leaves this function; file contents and keys stay private. */
export function hermesReadinessFingerprint(version, root) {
    const hash = createHash("sha256").update(version.trim());
    const profile = propertyProfileDir(root);
    let location = profile;
    try {
        location = realpathSync(profile);
    }
    catch { /* Missing profiles remain unready. */ }
    hash.update(`\0${process.platform}\0${process.arch}\0${location}\0`);
    for (const file of ["config.yaml", ".env", "auth.json", "SOUL.md"]) {
        hash.update(`\0${file}\0`);
        try {
            hash.update(readFileSync(join(propertyProfileDir(root), file)));
        }
        catch {
            hash.update("missing");
        }
    }
    return hash.digest("hex");
}
export function applyHandsReadiness(status, lastPing) {
    if (status.bootstrapPending || !status.cli.installed || !(status.cli.compatible ?? status.cli.matchesPin) ||
        !status.pack.installed || !status.pack.approvalsManual || !status.pack.workroomReady)
        return { ...status, ready: false };
    const version = parseHermesVersion(status.cli.versionText ?? "").product ?? "supported";
    if (lastPing?.kind === "ping" && lastPing.ok && status.workerFingerprint &&
        lastPing.workerFingerprint === status.workerFingerprint) {
        return { ...status, ready: true, detail: `Worker ${version} passed the hands test for this setup. Desk Recheck can ask it for the morning ledger.` };
    }
    return { ...status, ready: false, detail: `Worker ${version} and the pack are installed. Run the hands test before Recheck or Ask.` };
}
const VERSION_CACHE_MS = 60_000;
let cacheGeneration = 0;
const versionCache = new Map();
const inFlight = new Map();
export function clearHermesVersionCache() {
    cacheGeneration++;
    versionCache.clear();
    inFlight.clear();
}
export function probeHermesCli(cli, timeoutMs = 8_000) {
    const key = `${cli}\0${timeoutMs}`;
    const cached = versionCache.get(key);
    if (!process.env.VITEST && cached && Date.now() - cached.at < VERSION_CACHE_MS)
        return Promise.resolve(cached.result);
    const pending = inFlight.get(key);
    if (pending)
        return pending;
    const generation = cacheGeneration;
    const probe = new Promise((resolve) => {
        execCli(cli, ["--version"], { timeout: timeoutMs, env: { ...process.env, PATH: augmentedPath() } }, (err, stdout) => {
            const failure = err;
            const result = failure
                ? { state: failure.code === "ENOENT" ? "missing" : failure.killed ? "timeout" : "error", text: null }
                : stdout.trim() ? { state: "ok", text: String(stdout) } : { state: "error", text: null };
            // A transient miss must be retryable immediately, not sticky for a minute.
            if (result.state === "ok" && cacheGeneration === generation) {
                if (versionCache.size >= 8)
                    versionCache.clear();
                versionCache.set(key, { at: Date.now(), result });
            }
            resolve(result);
        });
    }).finally(() => { if (inFlight.get(key) === probe)
        inFlight.delete(key); });
    inFlight.set(key, probe);
    return probe;
}
export async function probeHermesVersion(cli) {
    return (await probeHermesCli(cli)).text;
}
export async function hermesStatus(opts) {
    const probe = await probeHermesCli(opts?.cli ?? hermesCli(), opts?.probeTimeoutMs);
    const versionText = probe.text;
    const matchesPin = versionText != null && hermesMatchesPin(versionText);
    const compatible = versionText != null && hermesIsCompatible(versionText);
    const version = parseHermesVersion(versionText ?? "").product ?? "supported";
    const pack = { installed: packInstalled(opts?.root), approvalsManual: approvalsAreManual(opts?.root), workroomReady: propertyWorkroomReady(opts?.root) };
    let detail;
    if (probe.state === "missing")
        detail = `The worker is not installed. Install the supported v${HERMES_PIN.product} worker, then apply Bud's hands safeguards.`;
    else if (probe.state === "timeout")
        detail = "The installed worker took too long to report its version. Retry the check; reinstalling is not required by this result.";
    else if (probe.state === "error")
        detail = "The worker could not report its version. Check that Bud starts, then retry the check.";
    else if (!compatible)
        detail = `This worker release has not been checked with RealBud. Supported releases are ${HERMES_COMPATIBLE_RELEASES.map(release => `${release.product} (${release.calendar})`).join(", ")}; the fallback pin is v${HERMES_PIN.product}.`;
    else if (!pack.installed)
        detail = `Worker ${version} is supported, but Bud's hands safeguards are not installed. Apply them in You → This office.`;
    else if (!pack.approvalsManual)
        detail = `Worker ${version} needs manual approvals on Bud's hands. Re-apply the safeguards.`;
    else if (!pack.workroomReady)
        detail = `Worker ${version} needs the current private workroom policy. Re-apply Bud's hands safeguards.`;
    else
        detail = `Worker ${version} and Bud's hands are installed. Run the hands test before Recheck or Ask.`;
    return {
        pin: { ...HERMES_PIN },
        handsLabel: BUD_HANDS_LABEL,
        cli: { installed: probe.state !== "missing", versionText, matchesPin, compatible, probeState: probe.state },
        pack, homeDir: hermesHome(opts?.root), profileDir: propertyProfileDir(opts?.root),
        installCommand: hermesInstallCommand(opts?.platform ?? process.platform), bootstrapPending: workerSetupPending(opts?.root),
        installerAvailable: ["darwin", "linux", "win32"].includes(opts?.platform ?? process.platform), signInCommand: `hermes -p ${currentWorkerProfile().profile} model`,
        detail, ready: false, ...(versionText ? { workerFingerprint: hermesReadinessFingerprint(versionText, opts?.root) } : {}),
    };
}
