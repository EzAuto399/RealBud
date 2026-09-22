# Interrupted memory recovery and private profile provisioning

22 September 2026 continuation of [typed proposals](HERMES-TYPED-MEMORY-PROPOSALS-2026-09-22.md) and the [held Windows journal candidate](HERMES-WINDOWS-MEMORY-JOURNAL-2026-09-22.md). This wave closes local operator-recovery and profile-provisioning gaps. It is not whole-product production acceptance.

## Staff recovery

You → Bud → Bud’s memory now includes interrupted proposals. A valid prepared journal with no recoverable payload can be closed after explicit confirmation. This changes only its signed administrative record. It neither edits memory nor creates a human approval/rejection, and does not claim that no historical memory change ever happened. A new change requires a new user request and normal review.

The endpoint selects the full 64-character proposal identity and accepts only the displayed recovery digest. The host supplies workspace/profile/runtime identity and signing authority. Under the existing native review lock, the helper checks the signed prepared record, exact digest, full-key collisions sharing a native ID, and absence of stage, pending file, cleanup claim and any human receipt. Any ambiguous evidence remains held. Once proposal journals exist, evidence directories are verify-only; neither a normal review refresh nor recovery can recreate deleted parents and turn missing evidence into apparent absence. Fresh producers initialize these directories before durable intent. Older journals with missing or never-created evidence parents remain held for service recovery. A v2 closed journal retains original identity/digests and a domain-separated recovery digest; existing v1 prepared/published records retain their format. Exact replay returns the original closure. Subsequent same-key publication returns a fixed terminal `proposal-closed` result.

The ordinary staff route is limited to this exact closure operation; provider administration remains protected. The model receives proposal authority only and cannot close or approve. The normal review and recovery panels serialize requests through one queue. After a lost response, the UI checks the exact full key and digest before reporting closure; it never automatically repeats POST. Conflicting or absent records remain unresolved. Disabled or malformed memory configuration does not prevent metadata-only recovery, but native admission and locking remain required.

## Profile provisioning

Pack setup, existing-profile admission, skill copying and provider/config updates now share bounded profile IO. New directories and empty stages are made private before content is written. Existing Windows objects are verify-only; links, ambiguous ancestry, hardlinks, changed identities and unsafe grants are refused. Writes publish complete private files without truncation or a copy fallback. Newly published `.env` and configuration files use mode 0600 on POSIX. Existing POSIX modes remain compatible; startup does not silently chmod or rewrite an installed profile.

Normal startup provisions the owned home before setup. Direct runtime update also admits that home before starting an installer. Shipped skills use bounded per-file copying and preserve existing files. Windows legacy recursive profile migration is explicitly held before mutation; it has no admitted credential/database migration protocol.

Profile and credential changes remain separate whole-file writes, not a new multi-file transaction. A later config write can fail after a credential write; there is no automatic claim that both committed together. Synchronous Windows admission preserves current function contracts but adds 8–9 sequential verify-only PowerShell checks on ordinary existing-profile startup, each bounded at 15 seconds. Actual startup latency, ACL behavior and first-install/update behavior must be measured on Windows. This source work does not remove the native memory platform hold or protect secrets from the machine’s own administrator.

## Verification

Current-wave logs, rendered captures and exact source fingerprints are under `outputs/hermes-memory-followup-2026-09-22/`. The final `verification.json` records the completed layers and preserved negative runs. No unrun Windows or customer test is counted as passed.

- Final full source suite: **4,408 passed, zero failed, 143 environment-gated skips**, 344 files, 319.55 seconds. The admitted Hermes runtime was explicitly enabled; source inputs remained unchanged throughout this final run. The earlier run’s four failures were all API-fixture `/var` aliases; the fixture now uses its canonical temporary path, and all 51 API cases passed before the clean full rerun. No production check was weakened.
- Profile setup/update/security: **180 focused checks passed**, six actual-Windows ACL cases skipped. Separate server/UI typechecking, Electron syntax, UI/server builds and package preparation passed.
- Actual admitted native helper and HTTP: **60 focused checks passed after the ancestry fix**, including crash-produced closure, exact replay after service restart, stale digest/artifact refusal, ordinary memory review and the fictional Ask → ACP → proposal path.
- Python fault/recovery: **25 closure cases** (including twelve missing-parent subcases), **15 POSIX crash/replay regressions** and **25 real-helper cases through fake Windows IO** passed. These counts overlap other layers and are not summed as independent product coverage. The six pre-fix missing-parent reproductions remain in the negative evidence receipt.
- Rendered UI: **13 source checks** and **16 exact-package checks** passed at desktop and 390px mobile sizes. Captures were visually inspected. Actual native commit followed by a deliberately dropped browser response reconciles without another POST. Ordinary staff permissions are used; no page errors or off-origin browser requests occurred, and all disposable services/profiles/peers were cleaned up.
- Fresh unsigned macOS arm64 package: `outputs/hermes-memory-followup-2026-09-22/package/mac-arm64/RealBud.app`. Electron 43.4.0 / Node 24.18.1 runs the compiled service, bundled UI and exact Python helpers. The native renderer/capability/service/shutdown smoke passed. The installed `/Applications/RealBud.app` was not replaced.

Final source fingerprint: **1,072 recorded inputs**, digest `3aec9bcb0a2771aa18ba316fda24fd7be55d21171c3ebe98cae01d9fdf2494b5`. The only source change after packaging was the API-test temporary-path correction. The package fingerprint covers **2,419 files and 14 symlinks**, digest `c597b054062e8515b1254497a4115b59d8d5b3e8f11db63c277976bf8db67a4e`; it stayed unchanged after verification. All five memory helpers match source, compiled output and the packaged dependency manifest.

## Grok development tooling

The owner’s `grok-4.7 --reasoning-effort xhigh` preference remains in effect. Installed CLI 1.0.34 completed a bounded health check in 9.12 seconds and reported actual model `grok-4.7-build`. A separate focused closure-contract design review reached its 180-second limit with no findings and was terminated; it is an incomplete review, not approval. Both receipts preserve terminal status and cleanup. Global CLI configuration remained unchanged.

The health probe’s inspection metadata reported no active MCP servers, but runtime output still advertised 24 tools and a connected Semble server. No actual tool call occurred in the completed probe. CLI tool isolation is therefore unverified. Further Grok use must retain bounded tasks and inspect actual results; availability alone does not establish a completed audit.

## Remaining release gates

- Actual Windows NTFS/ACL/identity/CRT locks, interruption/retry, disk-full and retained-deletion tests; then exact installed proposal/review/recovery and profile-setup flows. Portable and fake-IO tests do not satisfy this gate.
- Real OS Keychain/DPAPI custody, signed/notarized distribution, installed restart/sleep/reconnect and two-computer office operation.
- Deployed managed-provider/connector custody and subscription revocation with tenant isolation. A hidden local administrator password cannot enforce licensing against the device owner.
- Austin’s original/corrected CSV evidence, authenticated Gmail coverage and supervised REI Cloud acceptance, followed by customer-scale and sustained office operation.
