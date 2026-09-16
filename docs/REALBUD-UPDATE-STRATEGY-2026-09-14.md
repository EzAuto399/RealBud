# RealBud: stay current through verified updates

14 September 2026 · Required product behavior · Proposed strategy, not an enabled updater service

## User outcome

The owner should be able to keep RealBud and its supported engines/drivers current without reinstalling the office or maintaining terminal commands. Use **the newest stable combination verified for this office's platform**, with automatic discovery, staging and owner-configured idle-time activation. Preserve company work, private learning, connections and recovery throughout.

Do not float production dependencies to upstream `main` or untested `latest`. A new release is a candidate until its exact integration passes. Show **Active**, **New upstream release**, **Being checked**, **Ready to update**, **Waiting for work to finish**, **Restart required**, **Updated**, **Held**, or **Recovery needed** truthfully. No policy or permission expansion is hidden inside an update.

The user request is for this capability to be designed and built. This documentation does not install a candidate, activate automatic updates, publish a feed or change an office's maintenance policy.

## Separate update owners

| Component | Update unit | Owner |
|---|---|---|
| RealBud desktop, host and companion | Signed app/service artifacts plus supported protocol/schema versions for each OS/architecture. | RealBud release pipeline and company maintenance controller. |
| Hermes | Exact official release commit, installer digests, runtime environment and admitted adapter/tool contract. | Existing RealBud runtime manager extended for company workers. Stock upstream source stays unmodified. |
| Cua | Matching native executable, SDK, helper libraries, capability manifest and selected broker/wrapper contract. | RealBud platform release/admission; no independent wrapper auto-repair. |
| QM-derived code | Reviewed upstream changes selectively adapted into RealBud with attribution and regression tests. | Normal RealBud source/release process; not an independently self-updating QM daemon. |
| Composio | Client adapter version, toolkit/action versions, schemas and scoped connection behavior. | RealBud integration release; no automatic unversioned business-operation change. |
| Workflow packs and reviewed CLI adapters | Content digest, dependencies, schemas, source bindings and migration/compatibility declaration. | Host-owned pack manager; preserve private bindings and learned corrections. |
| Browser/runtime dependencies | Admitted browser capabilities and lifecycle; external user browser updates observed separately. | RealBud compatibility checks; do not take over updating a person's browser without an explicit supported arrangement. |

There may be multiple component versions in an approved release bundle, but each active job freezes its selected versions. The host negotiates protocol/capability compatibility with each client/companion. A recently updated host cannot assume all offline desktops have already updated.

## What exists today

Current source has manual Hermes upstream discovery, an explicit approved-release catalog, fresh installer candidates, official commit/hash verification, an isolated ACP smoke check, atomic selection for next launch and manual previous-runtime selection. Native memory/skills and private settings are intended to survive managed runtime updates. The catalog is shipped with RealBud; a dynamic signed remote compatibility feed is not implemented.

Electron app-update code checks automatically on packaged builds, while download/install is user-triggered. That does not establish a safely signed, coordinated company updater: current Windows packaging lacks its final signing configuration, and app-update discovery is not a company-wide job drain or health rollback controller. Cua is currently packaged at a fixed version. Recheck the exact current source paths before implementation.

Relevant source owners: `server/hermes-releases.ts`, `server/hermes-update.ts`, `server/hermes-runtime-selection.ts`, `server/hermes-runtime-check.ts`, `electron/main.mjs`, `electron/updater.mjs`, `electron/shutdown.mjs`, `scripts/prepare-cua.mjs`, `electron-builder.yml` and `src/components/AgentUpdates.tsx`. See the dated [Hermes update implementation record](REALBUD-HERMES-UPSTREAM-2026-09-12.md); its 12 September version claims are historical and superseded by the 13 September release evidence.

## Proposed release and activation flow

1. **Discover.** Check official release sources with bounded requests, caching and retry. Record upstream tag/commit/digests and release time. Network failure leaves the active system usable and reports last successful check. No candidate code executes just because discovery found it.
2. **Admit centrally.** Build/test each advertised OS/architecture combination against RealBud's actual contracts. Exercise real stock-Hermes ACP/model/file/memory/skill behavior, safe-mode configured-versus-explicit tools, exact Composio account/operation policy, native driver identity/Stop/recovery and representative workflows. Sandbox admission uses synthetic data and designated test credentials, not a customer's private office.
3. **Publish approved metadata.** A future signed compatibility manifest identifies exact artifacts/digests, OS/architecture, minimum client/host protocol, schema/profile compatibility, permissions, release notes, rollback target and withdrawal status. Clients pin a signing root and verify signature, expiry and monotonic version/sequence to resist replacement/replay. Root-key rotation is explicit and tested. TLS alone does not replace signed metadata.
4. **Stage locally.** Download to a fresh immutable candidate directory, verify signatures/digests, preflight disk/dependencies and run non-effecting local health checks. Keep current runtime and persistent company/worker data separate. Verified downloads may resume; an interrupted Hermes installation must retry in a fresh candidate UUID/directory rather than rerun the installer in its old checkout, which could follow upstream main. Clean only owned incomplete artifacts; never replace the active executable in place.
5. **Wait for a safe boundary.** Under the owner's chosen update policy, stop taking new applicable work, preserve queued work and wait for active jobs, pending tool effects and credential refresh ownership to settle. Obtain acknowledged companion/worker Stop when needed. A timeout is not proof that an old process stopped. Unknown effects remain held for reconciliation; no release of their device merely to finish an update.
6. **Activate one verified selection.** Take the existing setup lock plus the company maintenance lock, revalidate expected active version, current grant epoch, release approval/withdrawal and metadata freshness, make a verified consistent backup where needed, and atomically select the candidate. Restart the affected host/worker/companion in a bounded order. Invalidate old transport endpoints/refs and negotiate versions before new dispatch. Do not roll a running job silently onto another driver.
7. **Check health.** Verify installed artifact identity, service availability, current membership/private scope, database/profile compatibility, worker readiness, exact native capability and safe result persistence. An installed version string alone is insufficient. Live source tests need the office's current permissions; do not introduce new external effects as an update health check.
8. **Commit or recover.** Record success only after health passes. Revalidate retained-release approval, withdrawal and metadata freshness before rollback too. If the target remains admissible and rollback is compatible with the latest data/profile schema, drain and select the retained approved version. If migrations or new writes make executable rollback unsafe, freeze affected work and recover/forward-repair the latest authority. Never restore stale JSON/SQLite or overwrite newer company records to make a rollback pass.

Persist a maintenance journal before each consequential staging/selection/migration/activation/recovery transition. Record previous and candidate identities, intended step, fencing generation, data/profile compatibility and rollback eligibility. After any restart, reconcile actual running and selected versions against that journal before dispatch resumes; a receipt written only after success is insufficient. Define bounded offline metadata freshness explicitly and hold affected activation/rollback when eligibility cannot be established. A bundle can be withdrawn after staging, including a retained rollback target.

Keep acquisition/admission/distribution/activation distinct. For example, a newer Hermes may be downloaded but held because the Cua manifest or ACP isolation check fails. Explain that specific reason and retain the working version. Do not call the newest upstream code EOL or insecure solely because it has not passed RealBud admission.

## Owner experience and automatic mode

Put **You → Updates** under the existing four-place navigation. Show current app/engine/driver versions in progressive disclosure, the last successful check, whether this device hosts the company, and the work/restart impact of an update.

Support manual activation and an owner-configured **Automatically install compatible stable updates when idle** policy. After that policy is chosen, ordinary already-approved compatible updates need no repeated confirmation. New source privileges, new external services, incompatible data migrations or an expanded maintenance impact require their own explicit decision; an update policy is not permission to add them.

Automatically check for approved releases and optionally stage verified candidates. Define the cadence, bandwidth/disk budget and maintenance window as product settings; do not create a second scheduler for office work. A preview channel is optional developer-only work and never the production default. Do not promise same-day support for every upstream release; track admission lag and explain holds.

Expose **Check now**, **Update when idle**, **Pause automatic updates**, **Restart to finish**, and **Restore a compatible previous version** as appropriate. “Pause updates” does not pause office work. “Roll back” does not mean erase new data. Show offline/stale-check states and the affected device's update state, not only the host's.

## Failure and acceptance contract

Test invalid signature/digest, stale/replayed metadata, unavailable feed, revoked release, insufficient disk, concurrent setup, interrupted staging, denied OS permission, client/host protocol mismatch, device offline, worker still alive after timeout, unknown external effect, crash during activation, profile/schema incompatibility and recovery to a compatible previous release.

Verify on **Windows x64 and macOS arm64** for the currently intended artifacts. Add other advertised architectures only with complete packaging and installed evidence. Windows signing/publisher validation and macOS signing/notarization/permission continuity are required release work. Keep actual customer hardware and full workflow acceptance distinct from CI package smoke checks.

Retain a bounded number of verified previous runtime bundles according to explicit disk/rollback policy. Old binaries may be cleaned only after no live process/job references them and a viable recovery target remains. Company records, credentials, native memory/skills, browser cookies and support evidence are not disposable runtime caches.

Composio cancellation may leave an unknown result; Cua Stop needs acknowledgement; native browser sessions may require reattachment after a process generation changes. Test those facts across an update instead of assuming a successful process restart proves continuity.

No formal upstream support/EOL date should be invented. Maintain RealBud's own admitted-version inventory, security/advisory review, OS/browser compatibility monitoring and explicit capability-retirement rules. A critical incompatibility can hold the affected capability while unrelated work remains available.

## Implementation mapping

Expand N12's lifecycle work rather than create a separate update architecture. Its dependencies include N06 driver admission, W03 worker supervision, H05 independent host service, R01 consistent backups and R02 host trust/fencing. R04/R05 must produce signed artifacts; R06 must verify activation/rollback after those artifacts exist. A future signed compatibility feed requires its own keys, publication controls and threat review before it is enabled.

The immediate step is to preserve the existing Hermes update foundations, close driver compatibility and company job ownership, then implement this policy through the shared maintenance controller. The [GPT-6 Pro handoff](REALBUD-GPT6-PRO-CORE-BRIEF-2026-09-14.md) explains the complete scope and the implementation prompt required next.
