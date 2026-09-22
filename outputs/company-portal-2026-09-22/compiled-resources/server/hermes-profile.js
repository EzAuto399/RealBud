// A worker operation has one immutable identity across setup, tools and execution.
// The base profile remains available for an office of one. Member profiles never
// inherit the base profile's credentials, memory or sessions.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { HERMES_PIN } from "./hermes-pin.js";
/** Longest profile name we will construct; Hermes profile names are directory names. */
const MAX_PROFILE_NAME = 64;
/**
 * The one shipped base Bud profile.
 *
 * Every execution route reads the profile through this function rather than
 * touching `HERMES_PIN` directly, so worker isolation has a single decision
 * point. It is a function, not a re-exported constant, so a future release can
 * resolve the base without editing call sites.
 */
export function baseWorkerProfile() {
    return HERMES_PIN.profile;
}
function sanitize(value) {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}
/**
 * Resolve the profile for one execution.
 *
 * With no member key the base profile is returned unchanged, so single-seat
 * installs and every existing profile on disk keep working. A member key
 * produces a stable, isolated profile derived from it.
 *
 * @param baseProfile The shipped base profile (see `HERMES_PIN.profile`).
 * @param memberKey   Stable identifier for the seat the worker acts for. Callers
 *                    pass the authenticated member identity, never a model- or
 *                    request-supplied name.
 */
export function hermesProfileFor(baseProfile, memberKey) {
    const base = sanitize(baseProfile);
    if (!base)
        throw new Error("A base Hermes profile is required to select a worker profile.");
    if (base !== baseProfile || base.length > 32)
        throw new Error("Invalid base Hermes profile.");
    const identity = typeof memberKey === "string" ? memberKey : "";
    if (!identity)
        return { profile: base };
    const key = sanitize(identity) || "member";
    const plain = `${base}-${key}`;
    // A double-hyphen digest namespace cannot alias a plain normalized ID.
    // Preserve existing UUID/lowercase IDs. Lossy normalization and truncation
    // must not let distinct authenticated identities share a directory.
    const digest = createHash("sha256").update(identity).digest("hex").slice(0, 20);
    const profile = key === identity && plain.length <= MAX_PROFILE_NAME
        ? plain : `${plain.slice(0, MAX_PROFILE_NAME - 23).replace(/-+$/g, "")}--m${digest}`;
    return { profile, memberKey: identity };
}
/**
 * Profiles that may exist for a base profile: the shared base plus one per
 * member. Used by diagnostics and by the installer to decide what it may create
 * or clean up; it never enumerates a user's personal Hermes profiles.
 */
export function hermesProfilesFor(baseProfile, memberKeys = []) {
    const names = new Set([hermesProfileFor(baseProfile).profile]);
    for (const key of memberKeys)
        names.add(hermesProfileFor(baseProfile, key).profile);
    return [...names].sort();
}
const workerScope = new AsyncLocalStorage();
export function currentWorkerProfile() {
    return workerScope.getStore() ?? hermesProfileFor(baseWorkerProfile());
}
export function withWorkerProfile(memberKey, work) {
    return workerScope.run(Object.freeze(hermesProfileFor(baseWorkerProfile(), memberKey)), work);
}
