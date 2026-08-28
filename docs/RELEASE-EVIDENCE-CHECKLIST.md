# RealBud release evidence checklist

Status: **QA-ready training appliance; distribution and live-office release blocked.**

This checklist keeps proof buckets separate. Passing an earlier bucket never
implies a later one. `docs/GOAL-PROMPT.md` and `docs/PILOT-CONTRACT.md` remain
authoritative if this file drifts.

| Bucket | Required evidence | Current state |
|---|---|---|
| Source | Node 24 tests, both typechecks, Electron syntax, production build, `scripts/e2e-walkthrough.mjs`, visible portal/bank walkthroughs and bounded/isolated CUA policy walks | Green working-tree run on 2026-08-28: 136 files, 948 passed, 8 skipped, all remaining gates green in 39.4s. The authenticated send probe also returned the code-owned 403. This is still not an immutable candidate |
| Package structure | Fresh artifact; bundled UI/server/property safety pack/CUA/speech resources; exact CUA 0.19.3 version; expected native architecture; hardened signature/entitlements; updater metadata | Fresh 2026-08-28 macOS arm64 directory QA artifact built after the focused-onboarding and install-capacity changes is locally Developer-ID signed and verified as one app bundle, including every required property-pack, speech and CUA file. It came from the dirty working tree, is not notarized and is not a release candidate |
| Installed automation | Isolated HOME, Electron user data and RealBud data; first launch + restart; encrypted Desk/model persistence; safety-pack/manual-approval verification; packaged CUA resolution despite an ambient sentinel; private personal-Hermes/CUA sentinels; clean server and lock shutdown | The current artifact passed the two-launch macOS arm64 mock-Keychain smoke: encrypted Desk/model persistence, manual-approval safety pack, packaged CUA resolution despite an ambient sentinel, personal-Hermes/CUA isolation and clean lock shutdown. A separate explicitly isolated packaged-renderer run completed profile and three-rule first launch, focused setup, reload plus process-restart resume, compact You re-entry and Escape recovery at 900×600 with no renderer warning/error or horizontal overflow. It did not install the worker, attach a model, grant an OS permission or contact an external account. A prior packaged GUI pass installed the exact private worker in about 57 seconds and exercised Desk/Schedule/You, but that install was not replayed against this artifact because safe staging exceeded current free disk. Real Keychain/TCC and admitted live workflow execution remain separate buckets |
| Installed performance | Bounded install footprint; representative 100-property batch; restart/idle resource use; slow or interrupted network recovery | The private Python worker runtime is about 1.6 GB. This artifact now checks for 3.0 GB free both before the API admits preparation and again at the installer mutation boundary; the current 1.6 GB host state was held before staging with a PM-facing recovery message. The real install replay remains deliberately unrun, and the representative installed-office load/resource benchmark is not complete |
| Real OS first launch | Install outside the repo; real macOS Keychain/Windows credential protection; expected prompts; reopen/restart/recovery; no terminal or personal Hermes mutation | Not run |
| Named pilot | All eight fields in `docs/PILOT-CONTRACT.md`, mirrored in `server/pilot-contract.ts` | Blocked: Demo values remain |
| Live export | Exact PMS dialect, named exporter, stable identity column, cadence within 12 hours, missing/duplicate/ambiguous rows demonstrated fail-closed | Not run with a named office |
| Model and image | Previously pasted key rotated; replacement entered only in-app; hands test; conversation; selected screenshot/photo intake; no credential in logs or files | Not run with a funded replacement key |
| Vendor portal | Named vendor test account, bounded origin/actions/expiry, prefill evidence, Bud Submit denied, named human submits | Fake portal only |
| macOS release | Clean checkout; Node 24; release acknowledgement; Developer ID; notarize + staple; Gatekeeper; arm64 and x64 install/restart/update evidence | Not complete; current QA artifact is deliberately not notarized |
| Windows release | Supported worker story or explicit CSV-only product copy; Windows runner; Authenticode subject; signed NSIS/ZIP; install/update/uninstall; personal-Hermes isolation | Not complete |
| Publication | Versioned artifacts and matching updater metadata reviewed; explicit authority to upload/publish; rollback record | Not authorised or performed |

## Candidate commands

Run from a clean candidate checkout with no credentials in shell history or
logs. Release commands intentionally fail until the pilot and platform gates
are present.

```sh
node scripts/verify-source.mjs
pnpm package:mac:dir
OMB_CUA_RESOURCES=release/mac-arm64/RealBud.app/Contents/Resources node scripts/smoke-cua.mjs
node scripts/smoke-linux-package.mjs
pnpm package:mac:release
pnpm package:win:release
```

`verify-source.mjs` refuses Node older than 24 and stops at the first failed
gate. It does not prove packaging, installed first run, CUA permissions, a
funded model, a named office or a live portal. `package:mac:dir`, `package:mac`,
`package:win` and CI's unsigned Windows job
produce QA artifacts only. Only the gated `*:release` commands may produce a
release candidate, and they still do not authorise publishing.

## Manual acceptance record

For each manual run, record the app version/commit, platform and architecture,
the named tester, start/end time, exact bucket, pass/fail, sanitized logs and
artifact hashes. Never attach model keys, login cookies, tenant details or raw
PMS exports. A screenshot is supporting evidence, not proof of a send, payment,
portal effect or durable restart.
