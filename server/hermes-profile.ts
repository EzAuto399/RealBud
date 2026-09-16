// Which Hermes profile a given execution uses.
//
// The template-OS rule: RealBud ships ONE base Bud profile. A department or seat
// ("Accounts", "Property Management") is *configuration*, never a code branch —
// nothing here knows the word "accounts", and adding a department must not
// require editing this file.
//
// Today every worker runs the base profile, which is exactly the current
// behaviour, so this module is a seam rather than a behaviour change. It exists
// so the one place that decides worker isolation is explicit, tested, and
// callable from each execution route (Ask, hands, jobs) instead of four
// hardcoded `HERMES_PIN.profile` reads. Per-member isolation then becomes a
// change to this contract plus its call sites — not a hunt through the runtime.
//
// Why a member cannot simply share the base profile: one Hermes profile carries
// one private memory, skills store and session database. Two people (or two
// departments) sharing one profile share memory and create two writers on the
// same state, which is corruption, not cooperation.

import { HERMES_PIN } from "./hermes-pin.ts";

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
export function baseWorkerProfile(): string {
  return HERMES_PIN.profile;
}

export interface ProfileSelection {
  /** Directory name under `<hermesHome>/profiles`. */
  profile: string;
  /** The member this profile belongs to, when it is member-scoped. */
  memberKey?: string;
}

function sanitize(value: string): string {
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
export function hermesProfileFor(baseProfile: string, memberKey?: string | null): ProfileSelection {
  const base = sanitize(baseProfile);
  if (!base) throw new Error("A base Hermes profile is required to select a worker profile.");
  const key = typeof memberKey === "string" ? sanitize(memberKey) : "";
  if (!key) return { profile: base };
  const profile = `${base}-${key}`.slice(0, MAX_PROFILE_NAME).replace(/-+$/g, "");
  return { profile, memberKey: key };
}

/**
 * Profiles that may exist for a base profile: the shared base plus one per
 * member. Used by diagnostics and by the installer to decide what it may create
 * or clean up; it never enumerates a user's personal Hermes profiles.
 */
export function hermesProfilesFor(baseProfile: string, memberKeys: readonly string[] = []): string[] {
  const names = new Set<string>([hermesProfileFor(baseProfile).profile]);
  for (const key of memberKeys) names.add(hermesProfileFor(baseProfile, key).profile);
  return [...names].sort();
}
