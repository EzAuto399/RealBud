import { HERMES_PIN } from "./hermes-pin.ts";

export interface HermesRelease {
  product: string; tag: string; commit: string;
  installers: { unix: string; windows: string };
}

/**
 * The release a fresh install or an update receives.
 *
 * Named here, once, and referenced by name everywhere else. This value used to
 * be `HERMES_RELEASES[2]`, which meant reordering the catalog below silently
 * changed what every new office installed.
 *
 * Changing it is a RealBud release decision: match the upstream git commit,
 * pin the official immutable installer scripts by SHA-256, run the ACP smoke,
 * then recommend. Never follow upstream `latest`.
 */
export const HERMES_RECOMMENDED_VERSION = "0.21.2" as const;

// Release promotion is a RealBud compatibility decision. Bytes are official,
// immutable upstream installer scripts; no engine patches or branch tracking.
export const HERMES_RELEASES: readonly HermesRelease[] = [
  // Compatibility floor. Kept so an existing 0.20.3 office still reads as
  // supported and Repair does not treat it as a foreign installation. It is not
  // the release Restore selects: restore returns whatever the installation
  // previously ran, recorded in realbud-runtime.json.previous.
  { ...HERMES_PIN, installers: {
    unix: "0582d9b1562efcb6e0ac62f4451021667830b830a72ce7d91eaea9fee8b6c09b",
    windows: "74225bf244253bfa5bc2b1d16fa3bb8618e199a53d1c0344b37ab9930696d3ba",
  } },
  { product: "0.21.0", tag: "v2026.8.31", commit: "29112bef099274229cadff79cdff7bf7b99c4b77", installers: {
    unix: "85ef536d455e51ab67aa74d79272efd49fe717597dbaadfd3cca179a905f4706",
    windows: "65552df7a1214b288fbf858f47774e0a561d7587824948677633fda03a0686dc",
  } },
  // Admitted 2026-09-17 as installable but NOT recommended, so a candidate build
  // can be staged and smoked before it becomes what a fresh office receives.
  // (startRuntimeUpdate only ever stages HERMES_RECOMMENDED, so a release has to be
  // in this catalog before it can be evaluated at all.)
  //
  // Commit is the v2026.9.14 TAG, not a main-branch head. That distinction matters:
  // this machine's personal Hermes also reports "v0.21.3 (2026.9.14)" but is built
  // from upstream 6005aa1f, which is 1653 commits ahead of this tag — i.e. main,
  // which the comment above forbids following.
  //
  // Installer digests derived from
  // raw.githubusercontent.com/NousResearch/hermes-agent/<commit>/scripts/<file>.
  // The method was validated by reproducing the live 0.21.2 pins exactly before
  // being trusted here. Note install.ps1 is byte-identical to 0.21.2's — only
  // install.sh changed in this release.
  //
  // NOT YET RECOMMENDED: the pin procedure requires an ACP smoke against the new
  // worker, which has not been run.
  { product: "0.21.3", tag: "v2026.9.14", commit: "345cd2b057a452236de401d3534b8502a7465e8d", installers: {
    unix: "38547c22f4dd2224ba68a13bc3479309abb17e295b2a2ef79c2d1b8293bd822e",
    windows: "226c70a90ad47e8a4d34cb11aca4ecbeb649e2f9b67fbd009ea49791de2d56f5",
  } },
  { product: HERMES_RECOMMENDED_VERSION, tag: "v2026.9.11", commit: "939e45c91d751fadd94dcd1b873ac3cb44846213", installers: {
    unix: "5854b15670b51a8daae8f59ddfa917062de9f74be261eb73b4b8d719710f8968",
    windows: "226c70a90ad47e8a4d34cb11aca4ecbeb649e2f9b67fbd009ea49791de2d56f5",
  } },
];

function lookupRecommended(): HermesRelease {
  const found = HERMES_RELEASES.find(release => release.product === HERMES_RECOMMENDED_VERSION);
  if (!found) {
    // A build-time wiring mistake, not a runtime condition: fail loudly rather
    // than silently recommending whichever release happens to be first.
    throw new Error(
      `RealBud recommends Hermes ${HERMES_RECOMMENDED_VERSION}, but that release is not in the install catalog. ` +
      "Add it to HERMES_RELEASES before shipping.",
    );
  }
  return found;
}

/** The admitted release for fresh installs and updates. */
export const HERMES_RECOMMENDED: HermesRelease = lookupRecommended();
