# Two-device contract recovery plan — 22 September 2026

Read-only follow-up in `/Users/yoda/projects/RealBud`. Only this report was written. No contract/source/package/CI file was restored or changed; no network fetch, remote CI, installed device or customer account was used.

**The original 71-case catalogue is exactly recoverable. Restoring the two missing JSON files alone is insufficient:** the recoverable core register does not contain the `two_device_release_gate` object required by the checker. Preserve that distinction instead of presenting an inferred gate as recovered original data.

## Exact recoverable source

Local commit **`b20e1c9a942cde7bc2f2a92c7c973f93fedc78d1`**, dated **2026-09-16 19:01:49 +1000**, message “WIP: park uncommitted company-platform dump off main tip.” It is retained by local branch `wip/company-dirty-2026-09-16` and the locally available `origin/wip/company-dirty-2026-09-16` ref. No remote inspection was needed.

| Path at that commit | Bytes | Git blob | SHA-256 |
| --- | ---: | --- | --- |
| `docs/REALBUD-CORE-EXECUTION-2026-09-14.json` | 98,483 | `418fb492a595387065f5d51a189d3843144e1766` | `5f214d3dc25aa25910f6c852021287f3a71ba4d1dae51c5b45ea8ddec2b1e31b` |
| `docs/REALBUD-OPERATIONAL-ACCEPTANCE-2026-09-15.json` | 34,910 | `0dd19fe0d86c0b07da048af3ff59f7ab4695bb01` | `c91dd8605e3a63049613c60baec7b0ff55f20aa02726ad200a357e45bde8ea15` |
| `docs/REALBUD-TWO-DEVICE-ACCEPTANCE-2026-09-15.md` | 23,906 | `203ed5ea740965738460ad166948286651935915` | `00225e319fc8f0626cd3d7de2cc6e221797f046a7b2466d66ef072e09c93ea82` |
| `docs/REALBUD-OPERATIONAL-ACCEPTANCE-2026-09-15.md` | 18,485 | `f861b9c96d45e91baa107834073e6bf5e1e9f028` | `0f5c08c26461c572eb245dc3bf912377f51e1982ed2806c4f5440034d279f196` |
| `docs/REALBUD-CORE-EXECUTION-2026-09-14.md` | 78,804 | `6d105cf9c5beba387253d59c9042c027fafa800b` | `2f96d59337330e119ae532bee986f4d1f753c78db91945118c57f00eabaf7a56` |

Read an exact original without touching the checkout:

```sh
git show b20e1c9a942cde7bc2f2a92c7c973f93fedc78d1:docs/REALBUD-OPERATIONAL-ACCEPTANCE-2026-09-15.json
git show b20e1c9a942cde7bc2f2a92c7c973f93fedc78d1:docs/REALBUD-TWO-DEVICE-ACCEPTANCE-2026-09-15.md
```

The checker and its tests in the current tree are byte-identical to this WIP commit: checker SHA-256 `454957b19ca646755e1260cf90f41014ef7d7acd950781c54df772603440d120`, tests `f5b5766c5b8b0e21d0579b9a7ed530dea509654a869e5daddc2e31977fcdda2a`. Commit `287914a652b0a0b8e689bb70cc31bbfb7a1639e3` later added the checker to the main-line history without these JSON docs. The advertised package alias is absent even in the WIP commit; restoring that package file would not supply it and would overwrite unrelated changes.

`git log --all --reflog` scoped to the exact missing paths found only the WIP addition, with no later gate-bearing revision. The recovered register's top-level keys were parsed and `Object.hasOwn(register, 'two_device_release_gate')` is false. A bounded unreachable-object search (`git fsck --no-reflogs --unreachable --no-progress`) produced no result before its 30-second limit and was terminated; unreachable object history was therefore **not exhaustively searched**. No retry or arbitrary private-directory scan was made. PropertyMe currently contains only `docs/ONBOARDING-WALKTHROUGH.md` and is not a Git repository.

## What can be reconstructed from preserved specifications

References below mean files at the exact WIP commit, not current acceptance claims:

- **OP JSON / OP MD:** `REALBUD-OPERATIONAL-ACCEPTANCE-2026-09-15.json/.md`.
- **Two-device MD:** `REALBUD-TWO-DEVICE-ACCEPTANCE-2026-09-15.md`.
- **Current checker/tests:** unchanged historical `scripts/check-two-device-acceptance.mjs/.test.mjs`.

| Checker contract input | Source-backed value or mapping | Recovery status |
| --- | --- | --- |
| `catalogue.caseCount`, `catalogue.cases[].id` → `caseIds` | Exact catalogue has **71**, unique consecutive IDs **OP-001…OP-071**. Preserve all cases and their expected outcomes/evidence fields. | Exact bytes recoverable; no reduced catalogue needed. |
| `register.two_device_release_gate` | No such object in the recovered register. The checker only requires the four fields below; any replacement must be labelled a newly formalized contract with source provenance. | Original serialized object not recovered. |
| `targets['macos-rehearsal']` | `['macos-macos']`; Two-device MD lines 129 and 143 require the first physical two-Mac rehearsal. Current tests require one Mac pairing with 70 applicable checks. | Direct spec/test mapping. |
| `targets['full-platform']` | `['macos-macos','macos-windows','windows-macos','windows-windows']`, interpreted host first, peer second. OP-068 and Two-device MD lines 129–133 require all four. Current tests require four pairings and address the Windows device in the second pairing. | Direct spec/test mapping; array order follows existing tests. |
| `windows_only_cases` | `['OP-069']`: its perspective/action exclusively tests Windows standard-account/firewall/antivirus/native-picker behavior. 71 total minus this one equals the Mac test's required 70. OP-068 remains required for applicable pairing evidence; it is not Windows-only. | Source-backed derivation, not recovered original array. |
| `workflow_runs` | Six distinct runs below. OP MD lines 7 and 13–17 explicitly require **each of three workflows independently for A and B**, followed by handoff. | Source-backed derivation; IDs conform to existing checker/tests. |
| `both_members_cases` | Original array unavailable. At least OP-007, OP-013, OP-040, OP-045, OP-054 and OP-070 explicitly say **Two staff**. Existing test lines 101–109 additionally requires OP-050 to have both A and B. Two-device MD also requires attended work separately on each device, along with restart and shared-state checks; those broader requirements need an explicit case-by-case participant mapping. | **Not an exact recoverable list. Do not silently publish only these seven as the complete policy.** All 71 case checks remain in scope regardless of participant metadata. |

The supported six-run mapping is:

| Run ID | Case ID | Member | Source |
| --- | --- | --- | --- |
| `morning-a` | OP-019 | A | Accounts inbox journey. |
| `morning-b` | OP-020 | B | Second account's independent inbox journey; current tests compare the first two runs' distinct accounts/contexts. |
| `bills-a` | OP-026 | A | Independent expected-bill classification and human decision. |
| `bills-b` | OP-026 | B | The same full workflow for B, explicitly required by OP MD line 17. **OP-027 is the handoff and cannot replace this independent run**, as the existing test states. Reusing the case ID still requires separate job/attempt/result evidence. |
| `bank-a` | OP-032 | A | Accounts source/review/export journey. |
| `bank-b` | OP-033 | B | B's independently selected bank source. |

This mapping does not omit OP-027: its handoff remains one of the full case checks. The catalogue spans installation OP-001–006; identity/service 007–012; connections 013–018; inbox 019–025; bills 026–031; bank 032–037; sharing 038–044; worker/files/computer use 045–051; packs/schedules 052–057; recovery 058–062; usability 063–067; platform/capacity/diagnostics 068–071.

Every required **receipt field** also has a current source definition; none needs invented customer data:

| Receipt fields | Authoritative requirement / evidence meaning |
| --- | --- |
| `schemaVersion`, `target` | Checker schema 1 and exact requested target; default remains full-platform. Never infer full-platform acceptance from the Mac-only receipt. |
| `sourceManifestSha256`, `protocolVersion`, `reviewerAlias`, `reviewedAt` | Checker requires exact candidate digest, protocol and named/date-valid review. Two-device MD lines 133 and 139 require common source/protocol attribution and actual observations. |
| `pairings[].id`, `companyAlias` | Exactly the selected target pairings, no duplicates; intended common company. Two-device first-office rehearsal and OP-068. |
| `devices[].slot`, `memberAlias`, `deviceAlias`, `providerUserAlias` | Exactly A and B with separate members, devices and provider identities. OP-007/013/045; OP MD line 7 and Two-device identity/account sections. |
| `devices[].os`, `osVersion`, `architecture`, `environment` | Match pair positions; checker requires Windows 11 x64 and Mac arm64. Physical Mac/Mac; Windows-containing pairs may use physical or interactive-VM devices. Two-device MD 129–135 rejects CI/simulation as installed interaction proof. |
| `devices[].artifactSha256`, `hermesVersion`, `hermesCommit`, `cuaVersion` | Exact installed artifact and engine/driver attribution; checker requires a full 40-hex Hermes commit. Two-device MD recording section and current checker/tests. |
| `workflowRuns[].id`, `caseId`, `member` | Exact six-run mapping above; no duplicate IDs. Independent bills B cannot be represented by the colleague handoff. |
| `workflowRuns[].status`, `proofLayer`, `evidence` | Passing actual installed-device observation plus nonempty in-receipt-directory evidence whose SHA-256 still matches. Local-integration/CI/simulation cannot substitute. The checker verifies record structure and file integrity, not truth of observations. |
| `workflowRuns[].jobId`, `attemptId`, `workerContextAlias`, `resultReceiptId` | Real distinct job receipts; private contexts cannot overlap across A/B. OP-045 and recording section; no reused job can stand for separate runs. |
| `workflowRuns[].companyAlias`, `executionDeviceAlias`, `executionRoute` | Same intended company, selected member's device, exact `company-managed-hermes` route. Two-device managed-service execution contract; no standalone/fake worker substitution. |
| Morning `providerUserAlias`, `connectedAccountAlias` | Exact member's provider user and independently bound account; distinct morning accounts. OP-013/019/020 and connected-service model. |
| `checks[].caseId`, `status`, `proofLayer`, `evidence` | Exactly all applicable case IDs, each with passing installed-device proof and verified evidence files; preserve failure/not-run states until actual work passes. |
| `checks[].participants` | A and B required for each explicitly designated `both_members_cases` entry. Existing tests prove OP-050 is mandatory; complete policy reconstruction remains the specific unresolved item above. |

The `evidence[]` object is `{path, sha256}` with a relative, confined, nonempty regular file up to 16 MiB; missing/changed/traversing evidence fails. These are current checker constraints, not historical proof that any observation happened.

## Minimal implementation after the freeze

1. Recover the catalogue **verbatim** from the pinned blob and preserve the supporting Markdown as dated specification material. If the historical core register is restored too, keep its old statuses explicitly historical; do not promote its September 15 checkpoints to present delivery status. Do not cherry-pick the broad WIP dump.
2. Formalize a focused versioned release-gate contract with the mapped fields and provenance, or add the gate explicitly to the restored register with a new dated note. Resolve the full participant matrix from every OP case and Two-device requirements before claiming the gate is restored. Do not invent an original array, drop cases, or merely tune lists until tests pass.
3. Add the advertised `qa:two-device-evidence` alias and an explicit Node test command/CI step; the existing test is outside Vitest discovery. Retain every current negative test and add missing-contract/exact-case-inventory/participant-policy regressions where useful.
4. Verify: exact catalogue hash/count/unique IDs, all four targets, six independent workflow runs, OP-027 retained as separate handoff, blank templates denied, no reduced proof layer, OP-050 both-device evidence, file-integrity/path confinement, and no mutation of catalogue acceptance states. Synthetic checker tests remain checker proof only.

No implementation, passing restored gate, Windows acceptance or release authorization is claimed by this plan. The recoverable files and incomplete original gate are now precisely identified; all current product files remain frozen.
