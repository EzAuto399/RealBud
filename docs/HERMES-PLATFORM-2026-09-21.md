# Hermes capabilities and desktop platform evidence — 21 September 2026

RealBud already recommends the latest tagged Hermes release checked today: **0.21.3 / v2026.9.14**, source commit `345cd2b057a452236de401d3534b8502a7465e8d`. The local compatibility floor remains 0.20.3; it is not the fresh-install recommendation. A version string from an upstream-main checkout does not prove it matches the admitted tag. See [official release](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.9.14), `server/hermes-releases.ts`, and `server/hermes-runtime-check.ts`.

## Native skills and reviewed learning

The pinned engine reads native skill directories containing `SKILL.md` with YAML `name` and `description`; optional supporting files are an upstream capability. RealBud customer imports deliberately admit reviewed instruction content, not arbitrary executable archives. Skill scope is the authoritative current workspace profile: `propertyProfileDir()` → `<RealBud Hermes home>/profiles/<currentWorkerProfile().profile>/skills`. Profile names are never accepted from an import payload. [Pinned skill reader](https://github.com/NousResearch/hermes-agent/blob/345cd2b057a452236de401d3534b8502a7465e8d/tools/skills_tool.py)

The exact pin supports `skills.write_approval: true` and `memory.write_approval: true`. Skill mutations from foreground and background agents stage records in the active profile's `pending/skills/<id>.json`. Records carry an ID, action, origin, timestamp and proposed payload. Memory proposals have a separate queue. Upstream defaults these gates off and treats config-loading errors as off. Its staging function can report success after a storage error, so a proposal is visible in RealBud only when a valid durable record can actually be read. [Pinned write gate](https://github.com/NousResearch/hermes-agent/blob/345cd2b057a452236de401d3534b8502a7465e8d/tools/write_approval.py)

The background reviewer constructs a separate agent, limits dispatched tools, and auto-denies dangerous terminal approval. It does not inherit RealBud's foreground ACP review callbacks. RealBud therefore enforces the native gates, restricts background review to the exact admitted process-selected release, and clears extra tools and alternate reviewer routing. An older/custom worker retains ordinary Ask with background review off. `stagedLearningSupported`, `learningPolicyReady`, and `stagedLearningEnabled` report different states; support is not evidence that learning has run. [Pinned background reviewer](https://github.com/NousResearch/hermes-agent/blob/345cd2b057a452236de401d3534b8502a7465e8d/agent/background_review.py)

The compatibility floor also implements the automatic-review off-switch; explicit upstream refinement is a different path and is not offered as an unrestricted RealBud feature. [0.20.3 review trigger](https://github.com/NousResearch/hermes-agent/blob/7339f5f160db5c96657a3bab60151227cc61f66c/run_agent.py#L1833)

`pack/property/config.yaml` carries the safe defaults. `server/hermes-pack.ts` parses YAML strictly, rejects duplicate/unreadable settings, preserves other memory/skill preferences, and applies owned policy through explicit Repair. Existing settings are not silently overwritten at startup. Repair enables staged learning only when its supported runtime is active; a safely disabled learner does not block Ask. A pending update cannot switch a running worker's learning policy to the next executable.

Native pending approval can replay deletes, patches and support-file writes while bypassing the staging gate. RealBud's customer-pack review must not call that replay helper blindly: validate the exact active profile, proposal ID and digest; accept only supported instruction revisions in the customer namespace; and invalidate approval after instructions change. Native staging is not a filesystem sandbox. RealBud's existing terminal/file/ACP controls remain necessary. [Pinned skill writer](https://github.com/NousResearch/hermes-agent/blob/345cd2b057a452236de401d3534b8502a7465e8d/tools/skill_manager_tool.py)

Safe mode remains enabled. Upstream plugin discovery is skipped in safe mode; this is compatible with native skills and does not replace write approval. RealBud continues to mount only its explicitly brokered connections and keeps whole-script execution approval enabled. Upstream plugins, arbitrary MCP packages, messaging gateways and Hermes cron are not equivalent to admitted RealBud business workflows. [Pinned plugin discovery](https://github.com/NousResearch/hermes-agent/blob/345cd2b057a452236de401d3534b8502a7465e8d/hermes_cli/plugins.py)

## Platform changes and actual limits

| Area | Implementation / evidence | Remaining gate |
| --- | --- | --- |
| macOS | Packaging admits arm64; relative library links survive Node-based runtime copying. Unsupported CUA build architectures fail early. | This document does not claim a new signed/notarized or installed Mac build. |
| Windows | Packaging admits x64. Native Windows system tar replaces dependence on Unix unzip; Node copies PostgreSQL files without Unix cp. | No physical Windows machine was available in this session. |
| Private Hermes prerequisites | Setup, source verification and worker environment find the selected runtime's Git/Node/Git Bash. UTF-8 child I/O is explicit. A staged update retains the running runtime's paths. | Actual clean Windows Hermes installation and ACP work still need a Windows receipt. |
| Windows installer CI | Manual Package Windows workflow now selects the actual `RealBud-<version>-setup.exe` NSIS output, installs into a temporary path with spaces, runs checks through installed Electron, and retains receipts/logs. BrowserSkill and PostgreSQL executables are checked against staged hashes and actually launched; SQLite, CUA host and speech protocol are also exercised. A second probe starts compiled service code copied from that installation, checks the actual child PID over HTTP, authenticates company status, and executes certificate generation. | Workflow was edited, not dispatched here. Windows Server CI is not Windows 11/customer-device acceptance. GUI actions, microphone quality, browser login, office provisioning and update recovery remain separate. |

The pinned upstream Windows guide supports native Windows 10/11, documents Git Bash and UTF-8 setup, and notes that the dashboard's embedded POSIX terminal needs WSL. RealBud uses its own UI and an owned runtime/profile layout rather than the guide's default personal home. Its installed browser helper is separate from upstream's native browser tool. The guide's native-support history links [upstream PR #21561](https://github.com/NousResearch/hermes-agent/pull/21561); upstream's support statement does not certify RealBud's installer. [Pinned Windows guide](https://github.com/NousResearch/hermes-agent/blob/345cd2b057a452236de401d3534b8502a7465e8d/website/docs/user-guide/windows-native.md)

PowerShell execution policy is not bypassed. An office policy that blocks the verified installer remains a setup gate requiring that office's approved installation process. Hermes' installer may provision prerequisites and modify user-level dependency paths; skipping its separate PATH stage does not mean every prerequisite stage is free of user-environment effects. No upstream source was patched.

Windows screen-permission recovery now falls back to general privacy settings instead of camera access. Microsoft documents separate graphics-capture, microphone and camera pages; opening a camera page does not address screen capture. The URI fixture passes locally, but a Windows Settings launch is not verified on this Mac. [Microsoft Settings URI reference](https://learn.microsoft.com/en-us/windows/apps/develop/launch/launch-settings)

## Public Grok/X research receipt — 21 September 2026

The requested public research ran with installed Grok CLI **1.0.34**, after inspecting its help. The prompt allowed public X/web research, limited the result to six examples, prohibited local inspection, edits, posting and deployment, and asked it to separate demonstrations from assertions. Grok reported X keyword/semantic/thread search available and completed successfully; session receipt `01a0c1f1-da56-7702-aad3-dc918b214714`. Its startup emitted noisy global skill/hook warnings, so this is not described as an isolated zero-context research sandbox. No repository content or credentials were supplied in the prompt, and no second research call was needed.

The following are **Grok-retrieved X reports**, not independent reproduction. Direct X fetch through this session's web tool returned HTTP 403; actionable implementation facts below were therefore checked in the admitted upstream commit instead of assuming the posts proved them.

| Public example | What the returned evidence supports | What it does not establish |
| --- | --- | --- |
| [Marc Bara, 13 September](https://x.com/marc_bara/status/2099052224496140593) | First-person usage diary describing email triage, briefings, calendar/tasks and a custom MCP. | Operating system, restart/sleep recovery, mailbox coverage or delivery reliability. |
| [Hermes Release Watch, 19 September](https://x.com/HermesWatcher/status/2101385856821141949) | An unofficial follow-up-watch recipe with thread-aware tracking and Sent inspection before retry. | A measured live mailbox service or an official Nous release. |
| [Mining, 13 September](https://x.com/muhendismining/status/2099173044287569936) | An author-reported WSL2 service-detection fix and test/status results. | Native Windows installation, Task Scheduler recovery, or RealBud desktop behavior. |
| [Nous Research, 1 September](https://x.com/NousResearch/status/2094909051859542344) | Official desktop announcement and onboarding direction. | A successful clean installation on every supported platform. |

The exact RealBud pin already includes thread-aware inbox triage: bounded account/window retrieval, complete relevant threads, coverage gaps, a waiting-for-others disposition, source-based explanations, and read/draft defaults. It also requires provider readback and checking Sent before retrying an ambiguous send result. These are useful workflow requirements; they do not grant RealBud permission to send mail or make a connector operational. [Pinned inbox skill](https://github.com/NousResearch/hermes-agent/blob/345cd2b057a452236de401d3534b8502a7465e8d/skills/email/email-inbox-triage/SKILL.md)

The pinned daily-briefing recipe starts from a manually tested workflow, uses a self-contained fresh session and requires a running scheduler/gateway. RealBud keeps its own business schedule, authority and visible run receipts; upstream cron availability is not a reason to bypass those controls. [Pinned briefing guide](https://github.com/NousResearch/hermes-agent/blob/345cd2b057a452236de401d3534b8502a7465e8d/website/docs/guides/daily-briefing-bot.md)

Historical reports must not be presented as unresolved defects in this pin. It already keys time zones by profile/config identity, supports configured recurring catch-up, and distinguishes delivery outcomes from run execution. Overdue one-shots have a different grace policy from recurring work. The remaining RealBud acceptance cases are therefore profile/DST changes, sleep/restart/catch-up, duplicate prevention, complete-thread coverage and a visible persisted report—not a claim that Hermes lacks these mechanisms. [Pinned clock](https://github.com/NousResearch/hermes-agent/blob/345cd2b057a452236de401d3534b8502a7465e8d/hermes_time.py), [pinned jobs](https://github.com/NousResearch/hermes-agent/blob/345cd2b057a452236de401d3534b8502a7465e8d/cron/jobs.py), [pinned scheduler](https://github.com/NousResearch/hermes-agent/blob/345cd2b057a452236de401d3534b8502a7465e8d/cron/scheduler.py).

## Reproduction

Observed in this session: 146 focused tests across the ten files below passed; JavaScript syntax, workflow/profile YAML parsing and `git diff --check` passed. Full `pnpm typecheck` and `pnpm build:server` then passed after the parent resolved a concurrent TypeScript edit. The isolated service smoke was repeated against that successful build and passed, producing `outputs/hermes-platform-company-bundle.json`. No new native installer was built by this subtask; the parent integration pass owns the GUI package receipt.

Run the focused local suite with Node 24:

```sh
pnpm exec vitest run server/hermes-runtime-env.test.ts server/hermes-pack.test.ts server/hermes-lifecycle.test.ts server/hermes-update.test.ts server/hermes-status.test.ts server/worker-bootstrap.test.ts server/postgres-artifacts.test.ts server/postgres-relocatable.test.ts electron/package-files.test.mjs server/drivers/acp/acp.test.ts
pnpm typecheck
pnpm build:server
node scripts/smoke-company-bundle.mjs outputs/hermes-platform-company-bundle.json
```

The follow-up platform changes passed **12 tests across three files** and repeated the actual compiled service smoke successfully. The synthetic service fixture checks harness source selection and a missing-import failure; it is not a real server or certificate proof. The separate smoke uses the compiled application and actual TLS generator. Its child environment removes inherited provider credentials/module paths and isolates both Windows application-data directories; `ELECTRON_RUN_AS_NODE=1` is retained so installed Electron starts the service as Node.

```sh
pnpm exec vitest run electron/package-files.test.mjs electron/perm-settings.test.mjs electron/service-smoke.test.mjs
node scripts/smoke-company-bundle.mjs outputs/hermes-platform-company-bundle.json
# Optional third argument selects an installed Resources directory explicitly.
```

The ZIP/copy fixtures use only fictional files. On this Mac they exercise real local ZIP listing/copying and simulated Windows path selection; on the existing Windows CI test matrix, the ZIP case invokes real Windows system tar. The fixture test does not run a Windows binary on macOS.

On a disposable Windows CI host, after `pnpm package:win`, run PowerShell 7:

```powershell
./scripts/test-windows-installer.ps1 -Installer release/RealBud-0.1.19-setup.exe -ReceiptDirectory release/windows-proof
```

The script requires `CI=true`, refuses an existing user RealBud installation, bounds installer/probe waits, and attempts uninstall afterward. It intentionally cannot certify GUI or customer workflows. No paid model call, mailbox access, deployment or workflow dispatch is needed for the local checks above.
