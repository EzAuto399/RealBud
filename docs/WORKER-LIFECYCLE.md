# Worker lifecycle

Updated 2026-09-20. This document supersedes the August policy that only the original pin could run.

## Release selection

RealBud runs unmodified, reviewed Hermes releases. The recommended release is 0.21.3 (`v2026.9.14`); `server/hermes-releases.ts` records admitted versions and immutable source commits. The historical pin in `server/hermes-pin.ts` remains the fallback compatibility contract. Never run upstream main simply because it is newer.

Service administration owns install, model attachment, OAuth, repair, update and removal. The app offers release checks and a staged update with rollback. Local staging/admission is distinct from a shipped application or installed customer device. Updates preserve the current workspace's model configuration, credentials, private memory and work. Readiness must be re-established when its worker/profile fingerprint changes.

## One worker identity

`server/hermes-profile.ts` resolves a member to a private profile and freezes that identity for each asynchronous operation. The HTTP handler, Ask/channel dispatch, scheduled readiness and hands operations use it. Pack paths, model attachment, OAuth, connected-app identity and execution argv all resolve the same identity. ACP's warm-process signature includes argv, so it cannot reuse a process for another member.

An office of one keeps its existing `property` profile. The immutable `company-installation/workspace.json` manifest records the worker selector: null for an existing solo profile, or the preserved legacy member key. Office joining never renames or switches it. Standard lowercase/UUID legacy keys keep their profile names; lossy/truncated keys use the existing digest suffix rule. Another person uses a separate data profile. Profiles, tokens and histories are never merged.

Load the workspace manifest before accepting requests or starting routines. A missing first manifest is seeded once from an existing seat binding or explicit `REALBUD_MEMBER` override; malformed state fails closed. A later override must match the saved selector. `seat.json` now records only the current office member, and may be removed by a confirmed departure without changing the Bud. Connected-app identity, model configuration, OAuth, ACP and scheduled arguments use the stable worker selector.

Enrollment, sharing and departure have durable recovery journals. No worker-profile migration occurs while joining, so office membership does not need to interrupt an existing private job. See [office recovery](OFFICE-RECOVERY-RUNBOOK.md) and [implementation receipts](PRODUCTION-LIFECYCLE-IMPLEMENTATION-2026-09-20.md).

## Setup, repair and readiness

Install and Repair write the current workspace's safeguards, using the shared shipped pack. Model attachment and device-code sign-in affect only that profile. A successful version probe means installed; a configured model means attached; only a passing hands test for the current fingerprint means ready. A stale receipt cannot clear a current readiness problem. Boot recovery accepts every admitted compatible release, not just the old pin.

Hermes' native file, web, terminal, vision, delegation, skills and memory capabilities remain available through the existing ACP broker. Configured external MCP servers, global plugins and hooks remain suppressed in product runs. RealBud explicitly mounts authorized connected apps and computer tools, and whole-script execution requests remain reviewable. Enabling every upstream extension blindly is not a capability upgrade.

Removal remains an explicit administration action. The book and durable application work remain separate from the worker runtime. A missing/unready worker must be shown as needing setup; it must not look like a live integration.

## Website association

Attended saved website jobs use the per-attempt BrowserSkill broker and the connection chosen in **You → Browser**. Browser permission is private to this installation and revoked when the attempt stops; it is not inherited by a warm chat or shared by office membership. CUA is not mounted alongside it. Sign-in uses explicit page selection, visible account labels and a fresh check, followed by a separately selected next step. See [browser operation, bank boundaries and verification](BROWSER-INTEGRATION-2026-09-20.md). This browser connection is separate from the website account association below.

You → This office → Website account links this desktop to Account → Computers using an owner-issued code. This reports versions, readiness and last check-in, and supports revocation. It is independent of local member sign-in, provider setup and signed service entitlements. The website cannot execute remote commands through this link. See `website/supabase/README.md` and `docs/decisions/2026-09-20-hermes-and-installations.md` for the protocol and rollout gates.
