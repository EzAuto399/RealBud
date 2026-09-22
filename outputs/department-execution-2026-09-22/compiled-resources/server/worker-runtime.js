// Transaction boundary for RealBud's private worker runtime.
//
// The pinned upstream installer writes absolute interpreter/checkout paths
// into its launchers, so a verified directory cannot be renamed afterwards.
// RealBud therefore owns two stable private runtime slots and switches the
// public `worker/runtime` path with one symlink rename. The property profile,
// model credential and Desk data live outside both slots.
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync, } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { WORKER_HOME, workerRuntimeDir } from "./config.js";
export function workerRuntimePaths(root = WORKER_HOME) {
    const resolvedRoot = resolve(root);
    const slotsDir = join(resolvedRoot, ".runtime-slots");
    const paths = {
        active: workerRuntimeDir(resolvedRoot),
        slotsDir,
        slotA: join(slotsDir, "a"),
        slotB: join(slotsDir, "b"),
        legacyPrevious: join(resolvedRoot, ".runtime-legacy-previous"),
        activationPending: join(resolvedRoot, ".runtime-activation-pending"),
        nextLink: join(resolvedRoot, ".runtime-link-next"),
        legacyStaging: join(resolvedRoot, ".runtime-staging"),
    };
    const prefix = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`;
    for (const candidate of Object.values(paths)) {
        if (!resolve(candidate).startsWith(prefix))
            throw new Error("worker runtime path escaped its private root");
    }
    return paths;
}
function slotPath(paths, slot) {
    return slot === "a" ? paths.slotA : paths.slotB;
}
function removeManaged(path) {
    rmSync(path, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
}
function activeRuntime(paths) {
    try {
        const stat = lstatSync(paths.active);
        if (stat.isDirectory() && !stat.isSymbolicLink())
            return "legacy";
        if (!stat.isSymbolicLink())
            return "invalid";
        const target = resolve(dirname(paths.active), readlinkSync(paths.active));
        if (target === resolve(paths.slotA))
            return "a";
        if (target === resolve(paths.slotB))
            return "b";
        return "invalid";
    }
    catch (error) {
        return error.code === "ENOENT" ? null : "invalid";
    }
}
function readMarker(paths) {
    if (!existsSync(paths.activationPending))
        return null;
    try {
        const parsed = JSON.parse(readFileSync(paths.activationPending, "utf8"));
        const candidate = parsed.candidate;
        const previous = parsed.previous;
        if (parsed.version !== 1 ||
            (candidate !== "a" && candidate !== "b") ||
            (previous !== null && previous !== "a" && previous !== "b" && previous !== "legacy") ||
            candidate === previous)
            return "invalid";
        return { version: 1, candidate, previous };
    }
    catch {
        return "invalid";
    }
}
function writeMarker(paths, marker) {
    writeFileSync(paths.activationPending, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
}
function makeNextLink(paths, slot) {
    removeManaged(paths.nextLink);
    const target = slotPath(paths, slot);
    symlinkSync(relative(dirname(paths.active), target), paths.nextLink, "dir");
}
function replaceActiveLink(paths, slot) {
    makeNextLink(paths, slot);
    renameSync(paths.nextLink, paths.active);
}
function rollbackFromMarker(paths, marker) {
    const current = activeRuntime(paths);
    if (marker.previous === "a" || marker.previous === "b") {
        if (!existsSync(slotPath(paths, marker.previous)))
            return false;
        if (current === "legacy" || current === "invalid")
            return false;
        try {
            replaceActiveLink(paths, marker.previous);
            removeManaged(slotPath(paths, marker.candidate));
            rmSync(paths.activationPending, { force: true });
            return true;
        }
        catch {
            return false;
        }
    }
    if (marker.previous === "legacy") {
        if (!existsSync(paths.legacyPrevious))
            return false;
        try {
            if (current === "a" || current === "b")
                removeManaged(paths.active);
            else if (current !== null)
                return false;
            renameSync(paths.legacyPrevious, paths.active);
            removeManaged(slotPath(paths, marker.candidate));
            rmSync(paths.activationPending, { force: true });
            return true;
        }
        catch {
            return false;
        }
    }
    // A failed first activation has no previous runtime. Remove only the
    // active link; the unconfirmed slot is unreachable and will be replaced by
    // the next deliberate install.
    try {
        if (current === "a" || current === "b")
            removeManaged(paths.active);
        else if (current !== null)
            return false;
        removeManaged(slotPath(paths, marker.candidate));
        rmSync(paths.activationPending, { force: true });
        return false;
    }
    catch {
        return false;
    }
}
/** Repair only crash states with one unambiguous local answer. No download,
 * PATH probe, profile reset or personal-Hermes access occurs here. */
export function recoverInterruptedWorkerUpdate(root = WORKER_HOME) {
    const paths = workerRuntimePaths(root);
    try {
        mkdirSync(resolve(root), { recursive: true, mode: 0o700 });
        mkdirSync(paths.slotsDir, { recursive: true, mode: 0o700 });
        removeManaged(paths.nextLink);
        const marker = readMarker(paths);
        if (marker === "invalid") {
            return {
                action: "attention",
                detail: "RealBud found an unreadable worker activation receipt. Retry from You → Worker.",
                previousAvailable: false,
            };
        }
        if (marker) {
            const current = activeRuntime(paths);
            // Crash before the active-link switch: the prior runtime still owns the
            // stable path, so discard the pending transaction without changing it.
            if (marker.previous === null && current === null) {
                removeManaged(slotPath(paths, marker.candidate));
                rmSync(paths.activationPending, { force: true });
                return {
                    action: "quarantined-staging",
                    detail: "An interrupted first install was never activated. Install the worker again.",
                    previousAvailable: false,
                };
            }
            if (current === marker.previous) {
                removeManaged(slotPath(paths, marker.candidate));
                rmSync(paths.activationPending, { force: true });
                return {
                    action: "discarded-staging",
                    detail: "RealBud cleared an interrupted worker activation; the active worker was unchanged.",
                    previousAvailable: marker.previous !== null,
                };
            }
            const restored = rollbackFromMarker(paths, marker);
            if (restored) {
                if (existsSync(paths.legacyStaging))
                    removeManaged(paths.legacyStaging);
                return {
                    action: "restored-previous",
                    detail: "RealBud restored the last worker after an interrupted activation check.",
                    previousAvailable: false,
                };
            }
            if (marker.previous === null && !existsSync(paths.activationPending)) {
                return {
                    action: "quarantined-staging",
                    detail: "An interrupted first-install activation was isolated. Install the worker again.",
                    previousAvailable: false,
                };
            }
            return {
                action: "attention",
                detail: "RealBud could not safely finish recovery of an interrupted worker update. Retry from You → Worker.",
                previousAvailable: marker.previous !== null,
            };
        }
        const current = activeRuntime(paths);
        if (current === "invalid") {
            return {
                action: "attention",
                detail: "The private worker runtime points outside RealBud's managed slots. Reinstall it from You → Worker.",
                previousAvailable: false,
            };
        }
        if (current === null && existsSync(paths.legacyPrevious)) {
            renameSync(paths.legacyPrevious, paths.active);
            if (existsSync(paths.legacyStaging))
                removeManaged(paths.legacyStaging);
            return {
                action: "restored-previous",
                detail: "RealBud restored the last worker after an interrupted update.",
                previousAvailable: false,
            };
        }
        if (current === null && (existsSync(paths.slotA) || existsSync(paths.slotB))) {
            return {
                action: "quarantined-staging",
                detail: "An unconfirmed private worker is isolated from Bud. Install the worker again.",
                previousAvailable: false,
            };
        }
        if (current !== null && existsSync(paths.legacyStaging))
            removeManaged(paths.legacyStaging);
        const previousAvailable = current === "a" ? existsSync(paths.slotB) || existsSync(paths.legacyPrevious) :
            current === "b" ? existsSync(paths.slotA) || existsSync(paths.legacyPrevious) :
                false;
        return {
            action: "none",
            detail: previousAvailable
                ? "The active worker is isolated and one previous runtime is available for rollback."
                : "The worker runtime is isolated inside RealBud.",
            previousAvailable,
        };
    }
    catch {
        return {
            action: "attention",
            detail: "RealBud could not safely inspect its private worker runtime. Retry from You → Worker.",
            previousAvailable: false,
        };
    }
}
/** Prepare the inactive stable slot used as the installer's final path. */
export function prepareWorkerRuntimeStage(root = WORKER_HOME) {
    const recovery = recoverInterruptedWorkerUpdate(root);
    const paths = workerRuntimePaths(root);
    let current = activeRuntime(paths);
    if (recovery.action === "attention") {
        // A deliberate reinstall may replace an unreadable activation receipt
        // only when the stable active path itself is still one of RealBud's
        // managed runtimes. Ask remains gated until the new install succeeds.
        if (current !== "a" && current !== "b" && current !== "legacy") {
            throw new Error("worker runtime recovery needs attention");
        }
        rmSync(paths.activationPending, { force: true });
        removeManaged(paths.nextLink);
        current = activeRuntime(paths);
    }
    if (current === "invalid")
        throw new Error("worker runtime is not managed by RealBud");
    const slot = current === "a" ? "b" : "a";
    if (current === null) {
        removeManaged(paths.slotA);
        removeManaged(paths.slotB);
    }
    else {
        removeManaged(slotPath(paths, slot));
    }
    const staged = slotPath(paths, slot);
    mkdirSync(staged, { recursive: true, mode: 0o700 });
    return { ...paths, slot, staged };
}
export function discardWorkerRuntimeStage(root = WORKER_HOME, slot) {
    const paths = workerRuntimePaths(root);
    const current = activeRuntime(paths);
    const candidate = slot ?? (current === "a" ? "b" : "a");
    const target = slotPath(paths, candidate);
    if (current !== candidate && existsSync(target))
        removeManaged(target);
}
/** Switch the stable active path to the verified inactive slot. */
export function activateStagedWorkerRuntime(root = WORKER_HOME, slot) {
    const paths = workerRuntimePaths(root);
    if (!existsSync(slotPath(paths, slot)))
        throw new Error("verified worker staging runtime is missing");
    const previous = activeRuntime(paths);
    if (previous === "invalid" || previous === slot)
        throw new Error("worker activation state is invalid");
    const marker = { version: 1, candidate: slot, previous };
    writeMarker(paths, marker);
    makeNextLink(paths, slot);
    let movedLegacy = false;
    try {
        if (previous === "legacy") {
            removeManaged(paths.legacyPrevious);
            renameSync(paths.active, paths.legacyPrevious);
            movedLegacy = true;
        }
        renameSync(paths.nextLink, paths.active);
    }
    catch (error) {
        removeManaged(paths.nextLink);
        if (movedLegacy && !existsSync(paths.active) && existsSync(paths.legacyPrevious)) {
            renameSync(paths.legacyPrevious, paths.active);
        }
        rmSync(paths.activationPending, { force: true });
        throw error;
    }
    return { previousAvailable: previous !== null };
}
/** Mark the new active runtime known-good only after its stable-path probe. */
export function commitActivatedWorkerRuntime(root = WORKER_HOME) {
    const paths = workerRuntimePaths(root);
    const marker = readMarker(paths);
    if (!marker || marker === "invalid")
        throw new Error("worker activation receipt is missing");
    rmSync(paths.activationPending, { force: true });
    if (marker.previous !== "legacy" && existsSync(paths.legacyPrevious))
        removeManaged(paths.legacyPrevious);
}
/** Restore the runtime named by the pending activation receipt. */
export function rollbackActivatedWorkerRuntime(root = WORKER_HOME) {
    const paths = workerRuntimePaths(root);
    const marker = readMarker(paths);
    if (!marker || marker === "invalid")
        return false;
    return rollbackFromMarker(paths, marker);
}
