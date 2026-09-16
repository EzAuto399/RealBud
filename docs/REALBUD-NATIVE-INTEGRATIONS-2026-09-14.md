# RealBud native connections, computer use and browser utilities

14 September 2026 · Required extension to the [company-platform plan](REALBUD-COMPANY-PLATFORM-PLAN-2026-09-14.md) · Planning/source review only

## Required stack

**Composio is the native connected-services integration. Cua Driver is the native computer-use backend. Stock Hermes supplies reasoning, learning and admitted browser/CLI/file utilities. RealBud owns the person, source, job, permissions, clock and verified result across all of them. Windows and macOS are both release targets.**

Here, native Composio means first-class RealBud connection setup, account selection, status, reconnect, revocation and action execution through the official server API/SDK. Staff do not configure a generic MCP server. Composio remains a hosted credential/tool service; native product integration does not mean offline or local-only data processing.

The same UI and workflow capabilities must work from both client OSs. Native steps run on a compatible enrolled device, with the execution location visible. Windows-only software still requires Windows. OS-specific installation, crypto, permission and session behavior need separate tests, not a platform flag over a Mac implementation.

## Four routes, one authority

| Route | Use for | Runtime owner and boundary |
|---|---|---|
| Composio service action | Accepted mail/calendar/file and other connected-service operations. | RealBud host → validated operation → exact connected account → Composio → checked receipt/result. |
| Cua desktop/browser | Existing signed-in websites, native apps, browser interactions and approved file dialogs. | RealBud job broker → enrolled companion → one permission-owning Cua runtime → exact app/window/tab. |
| Admitted website/CLI adapter | A verified supported CLI or reviewed client derived from an approved website interaction. | Restricted job runner → typed adapter with constrained destination/credentials → result verifier. |
| Hermes local utilities | File parsing, document/spreadsheet transformations, analysis, search, code-assisted batches and reusable procedures. | Isolated worker with scoped inputs and RealBud-owned tools; accepted outputs return through the artifact broker. |

Choose the most reliable accepted route for the actual source. API and deterministic transforms often reduce GUI work; computer use remains available where needed. A route failure may propose another route, but it cannot carry over a broader login, source grant or approval. Do not retry an uncertain write through a different route.

The capability registry records the exact operation, implementation, version, input/output schema, supported OS/architecture, source/account requirements, action policy, foreground/background behavior, verifier, retries, cancellation and lifecycle status. Use declared/supported/tested/installed/live-accepted evidence separately. A tool discovered in a catalogue is not automatically executable.

## Native Composio

### Integration design

Use a pinned official `@composio/core` adapter in the host where it simplifies maintenance, or retain typed official REST where existing code already supplies the contract. Do not rewrite correct REST just to call it native. No Composio model/provider engine is required; Hermes remains the engine.

Known business workflows use exact, versioned operations and explicit connected-account IDs. Prefer fixed direct calls for their controllable schemas and per-call checks. A narrowly configured session is acceptable when it supplies needed discovery or lifecycle behavior; fix allowed tools, auth configurations and connected accounts, disable unnecessary autonomous connection management/sandbox features, and execute within that same scoped session. Do not mount unrestricted Composio discovery, bulk execution, proxy or workbench access into staff workers.

Composio identities are stable opaque mappings from RealBud company/member or deliberately established company-service principals. They are not device names, mutable email addresses or API-key hashes. Store exact `connectedAccountId`, auth configuration, provider account identity, source-resource limits, owner, audience and grant revision. A company-shared connection has explicit grants; it is not the first matching account found under the installation.

For an office-owned Composio project, the host retains its isolated project credential outside workers/renderers. A shared RealBud platform project key must stay in a managed connection broker, never be distributed to customer hosts or embedded in installers; that broker authenticates company/member requests and enforces exact account scope. Decide and prove the provisioning model before promising automatic company setup. Initial office-specific provisioning can be an operator setup step hidden from normal staff, not an invented provider API capability. Composio manages business-service credentials on supported hosted-auth paths. The worker receives a scoped operation handle and necessary result fields, never raw refresh tokens, provider cookies, session MCP URLs or project keys.

### Product journey

**You → Connections → choose service → choose personal/company ownership → review requested access → sign in in the system browser → verify the actual account → perform a harmless connection check → bind workflows.**

Ask can offer the same resumable connection card when work needs a source. The job waits without losing its checkpoint. Completion resumes only that intended job after checking current grants; opening an auth link is not successful connection evidence. Multiple accounts get explicit labels and provider identities, with exact selection per workflow. Disconnect distinguishes removing RealBud access, deleting a Composio connection and revoking access at the provider; report which action was actually verified.

Persist connection intent before opening the hosted link: company/member, intended provider principal/resource where known, auth config/scopes, nonce, expiry, returned connection ID and originating job. Poll or process the callback only under the authenticated actor, and verify the provider principal before granting business access. A forwarded Connect Link can be completed by someone else; the initiating `user_id` alone does not prove who consented. Hold mismatched or unverifiable binding.

Ordinary Composio hosted links and polling do not require exposing the LAN host. Its optional callback identity-verifier requires public HTTPS. Use a narrow RealBud-managed auth relay/verifier where needed for a trustworthy identity binding; otherwise prove a supported host-owned polling plus independent-principal-verification flow. Do not quietly require a customer cloud server, public office API or open database port. A provider whose binding cannot be verified is not enabled for self-service setup.

### Execution, triggers and recovery

At dispatch and resume, validate actor, exact account/resource, operation, schema version, policy/grant revision, payload, approval when required and idempotency key. Apply locked prohibitions before asking for approval: an Allow click cannot enable a prohibited operation. Validate every subaction in a batch; prohibit unrestricted proxy endpoints, code workbenches and account substitution. Exact origins/resource paths are stricter than a broad registrable-domain check.

Do not opt into arbitrary automatic local file upload/download. Transfer only approved artifact handles, with path confinement, hashes, audience, size/type and destination checks. Parse results against the admitted schema and read back saved records. A timeout/cancelled HTTP request does not establish that an external write was cancelled; reconcile uncertain effects before retry.

Production Composio events enter a verified public webhook receiver, if used, and then the company's authenticated outbound delivery channel. Validate signature, age, event ID, connected account and company mapping; deduplicate and persist before acknowledgement. A private office host is not itself the public webhook destination. Durable host polling is an initial option for accepted sources; do not label prototype subscriptions or polling as production push. Events and polling feed RealBud's one clock/job system, including catch-up and no-change/pending-work checks.

**Current source gap:** general Composio sessions use an installation identity and do not consistently pin exact accounts. The connected-app broker can classify a send-containing tool/batch as reviewable and dispatch it after Allow; this is not the required hard action allowlist. The bounded Gmail adapter already enforces stricter private-account/read-only behavior and is the reuse baseline. Source tests are evidence of the route, not evidence that a live send occurred. Close the general path before enabling broader staff connections.

Current product Connect buttons route through Ask. Legacy connector authorize/delete endpoints are denied in product mode; they are not a completed native account-lifecycle API. Add deliberate product routes for account-specific connect/complete/check/reconnect/disable/revoke so setup works even while Bud is busy. The current bounded Gmail path also limits threads/time coverage and omits attachments; complete the accepted morning and invoice acquisition scope explicitly.

Sources: [official authentication](https://docs.composio.dev/docs/authentication), [direct execution and versioning](https://docs.composio.dev/docs/tools-direct/executing-tools), [connected-account API](https://docs.composio.dev/reference/v3/api-reference/connected-accounts); current `server/composio.ts`, `server/composio-gmail.ts`, `server/connected-apps-broker.ts` and their tests.

## Native Cua Driver on both operating systems

Use RealBud's signed desktop companion as the owner of the computer-control runtime and OS permission experience. Prefer the supported app-hosted service/SDK arrangement for this product boundary. Hermes talks to the RealBud computer facade; it does not start another uncontrolled raw driver. Keep the existing device envelope, local command journal, fencing, account/window checks and acknowledged Stop from the company plan.

Current RealBud source pins `@trycua/cua-driver` and staged native artifacts to **0.19.3**. Current upstream research identifies **0.28.1** as a newer stable candidate; it has not been admitted or installed here. Pinned Hermes 0.21.2's native `computer_use` wrapper requires Cua **at least 0.20.0 plus specific manifest capabilities**, so it is not compatible with RealBud's current 0.19.3 merely because both use MCP. Existing RealBud uses an explicit computer MCP route.

The [official 0.28.1 release](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.28.1) and a [reported Windows bounded-executable path mismatch in 0.19.3/0.20.0](https://github.com/trycua/cua/issues/3196), with [merged fix](https://github.com/trycua/cua/pull/3299), justify candidate evaluation. The issue has not been reproduced in RealBud by this task. Add its canonical/runtime path case to admission, and recheck RealBud's current `semantic_v2` login verifier and pinned bounded manifest when updating.

Choose exactly one worker-facing computer facade. Evaluate the Hermes native wrapper only if it can bind to the RealBud-governed runtime/broker and preserves every action fence under headless ACP/safe mode. Otherwise use the RealBud brokered MCP tools. Set an authoritative, admitted driver command/endpoint; do not permit a wrapper to repair itself by downloading the latest driver. No double driver owner and no second unfenced computer toolset.

For an upgrade, pin together JS SDK, native binary, helper/DLL, manifest and wrapper/adapter schema. Test differences using synthetic windows first. Preserve the previous complete set for rollback and stop work during mixed-version/unsupported capability states. A release note or newer upstream browser feature is not proof for the existing pin.

Apply an explicit managed policy to every Cua launch: disable independent driver update checks and telemetry by default, verify the admitted environment controls, and keep RealBud's updater/diagnostics authoritative. Native Hermes wrapper defaults do not establish policy for RealBud's independently launched embedded runtime. Screen/history retention has a separate local policy. [Telemetry/update controls](https://cua.ai/docs/reference/cua-driver/telemetry).

| Windows | macOS |
|---|---|
| Package executable, UIA/helper dependencies and matching architecture; run the companion in the correct interactive user session. | Package/sign the permission-owning app/service and matching native SDK; preserve signing identity across updates. |
| Verify Windows 11 native control, DPI/scaling, executable/window identity, account, foreground/background capabilities, UAC/elevation, lock/logout and crash recovery. | Verify Accessibility and Screen Recording grant/denial/repair, window/tab identity, display scaling, foreground/background capabilities, lock/logout and crash recovery. |
| A service in a noninteractive session is not the user's desktop. Do not disable UAC or secure desktop to obtain control. | A background service cannot manufacture a logged-in GUI session or bypass TCC/FileVault. Permission changes may require relaunch. |

Current RealBud packages target Windows x64 and Mac arm64. Upstream support for Mac Intel or Windows arm64 does not establish RealBud package support; each advertised architecture needs its own artifact and installed acceptance. Both supported OS families remain mandatory; incomplete acceptance on one is not a completed dual-platform release.

Cua's exact selected-tab/background routes vary by browser and OS. A supported background text insertion does not prove that trusted clicking, drag or scrolling can stay in the background. Refuse unsupported shapes or explicitly switch to an attended foreground step. Browser reconnect invalidates previous target/ref generations. Do not silently select the first tab or send input to another window.

Sources: [integration choices](https://cua.ai/docs/concepts/choose-a-cua-driver-integration), [platform support](https://cua.ai/docs/reference/cua-driver/platform-support), [targeting/background behavior](https://cua.ai/docs/concepts/browser-targeting-and-background-delivery), [Hermes integration](https://cua.ai/docs/use-cua-with/hermes), [pinned Hermes driver contract](https://github.com/NousResearch/hermes-agent/blob/939e45c91d751fadd94dcd1b873ac3cb44846213/tools/computer_use/cua_backend_driver.py); `scripts/prepare-cua.mjs`, `electron/cua.mjs`, `electron-builder.yml`.

## Browser quality-of-life and session lifecycle

Provide **Attach this browser**, **Use a dedicated work profile**, **Continue after sign-in**, **Reconnect**, **Change account**, **Forget this session**, and clear download/output locations. These are operations on the selected person/account/device, not global browser settings. Prefer supported Chrome/Edge routes for initial acceptance; Safari, Brave, Firefox and embedded views are separate capabilities, not assumed Chromium-equivalent support.

The current Cua existing-profile setup route documents Chrome/Edge on Windows/macOS and currently requires English browser consent labels; unsupported browsers/locales need a deliberate attended fallback or further adapter work. Do not infer Brave support from an older RealBud shim comment. [Profile attachment contract](https://cua.ai/docs/reference/cua-driver/browser-profile-attachment).

There are two session modes:

1. **Existing browser:** attach an explicitly chosen running browser/window/tab. The browser retains its own cookies and sign-in. RealBud stores an opaque binding, account-verification evidence and lifecycle metadata; it does not extract the profile's cookie database.
2. **Dedicated work browser:** create an isolated profile on the enrolled device and have the person sign in normally. Retain its session through the browser/runtime's supported storage under the correct OS user. Protect profile files and metadata; never mount them into broad Hermes workers.

Retain cookies where the admitted browser owns them; use OS-protected encryption for RealBud-held sensitive session metadata and keys. On macOS this includes Keychain-backed storage; on Windows DPAPI-backed storage. Verify encrypted-at-rest browser state for the selected runtime separately: encrypting a metadata string does not prove the browser's entire profile is protected. DPAPI does not isolate secrets from another program running as the same Windows user, so worker confinement and credential-free broker handles are also necessary. [Electron security semantics](https://www.electronjs.org/docs/latest/api/safe-storage).

Do not place cookies, authentication headers, refresh tokens, full browser profiles or raw HAR files in prompts, Hermes memory/skills, company knowledge, Git, logs, ordinary backups or reusable packs. Sharing company knowledge never shares a browser sign-in. Do not clone cookies/keychains across people or Windows/Mac machines to make Join appear connected. Re-authenticate a replacement device; any future managed session migration needs its own explicit supported design and acceptance.

Implement expiry, logout and account-switch detection, one owner per profile, stale-target invalidation, refresh ownership, profile corruption recovery and verified local session removal. Forgetting local state is different from provider-side revocation; report each separately. Stop capture during password/MFA entry, and ensure those fields cannot enter screenshots, accessibility dumps, recordings or debug logs. If the runtime cannot guarantee safe observation for that surface, hand control to the person with capture suspended.

Admit useful browser operations individually: scoped semantic read/search, tab/window selection, wait-for-state, navigation, supported form fill, dialogs, screenshot evidence, approved downloads/uploads and deterministic result checks. Clipboard access, all-tab inventory, cookie export/import, local file upload and profile cloning are separate sensitive capabilities; they do not follow from basic browser access. Remote CDP credentials and debugging sockets remain local/private; no model-provided remote endpoint or persistent globally exposed debug port.

## Hermes website-to-CLI and utility reuse

The exact feature found in admitted Hermes 0.21.2 is the optional **`har-derived-api-client`** skill. Its scripts capture browser network interactions and summarise endpoints; a developer or agent then drafts an HTTP client for review. This is a useful connector-development aid, not a guaranteed supported public API for every website.

Reviewed stock scripts capture full request/response data, and their endpoint sample output is not sufficient secret sanitisation: excluding a Cookie header does not remove Authorization/API-key headers or tokens in URLs/bodies. The CDP capture path also selects a first context/page rather than RealBud's attached target. Do not expose those scripts directly to staff as an automatic site-to-CLI button, or patch the upstream scripts in place.

Build a RealBud-owned admission path around the idea:

**Selected authorised operation → bounded capture on exact target → sanitisation before model/tool output or persistence → typed client proposal → endpoint/action/credential review → fixture and denial tests → pinned adapter version → controlled promotion.**

Capture selected destinations and necessary fields only. Redact tokens, cookies, authentication headers, sensitive query parameters and response content before interpretation; raw material, when indispensable, is short-lived and protected with explicit retention. Generated clients reference credential handles, not embedded secrets. Restrict host/path/method, redirects, private-network access and request schemas. HTTP GET is not by itself proof of read-only behavior; verify the actual business operation. Never replay login/MFA requests or discover broader permissions by probing unapproved endpoints.

Prefer an official supported API/CLI when it satisfies the workflow. A derived private endpoint is versioned and labelled fragile; changed schema/account/session/CSRF behavior holds the job for revalidation. A successful generated script does not prove ongoing correctness, authorized submission or cross-platform installation. Maintain endpoint drift fixtures and a supported fallback; uncertainty about an earlier write must be reconciled before fallback execution.

Reuse Hermes's analysis, file/code batching, skills and change-detection ideas through the existing worker. Permit deterministic scripts for accepted transforms and source checks without needless model calls; keep RealBud's single scheduler. Preserve native memory and skills without giving them source credentials or permission-writing powers. Browser-use/agent-browser, profile snapshots, CDP setup and authentication-vault utilities are admission candidates, not automatically enabled simply because a stock skill can invoke them.

Pinned ACP includes native browser tools, while excluding native `computer_use`; safe mode does not disable all native browser actions. `browser_exec` can execute Python, raw CDP accepts broad protocol methods, and console evaluation can bypass a narrow visible-tool list. The restricted worker must not have a credential-bearing browser/profile or an unfenced browser endpoint. Test all three paths, not just the mounted Cua tools. [Pinned toolsets](https://github.com/NousResearch/hermes-agent/blob/939e45c91d751fadd94dcd1b873ac3cb44846213/toolsets.py), [browser execution](https://github.com/NousResearch/hermes-agent/blob/939e45c91d751fadd94dcd1b873ac3cb44846213/tools/browser_use_cli.py#L581-L631), [CDP dispatch](https://github.com/NousResearch/hermes-agent/blob/939e45c91d751fadd94dcd1b873ac3cb44846213/tools/browser_cdp_tool.py#L258-L302).

Hermes's local browser vault encrypts with a Fernet key stored beside the encrypted vault under the profile home; it is not OS-Keychain/DPAPI isolation from an agent that can read both files. Origin-bound opaque handles are useful design input, but automatic vault login stays outside the current human-sign-in rule. Profile snapshots also copy authentication databases and require the browser closed on Windows; do not make that the default Join or existing-browser flow. [Vault storage](https://github.com/NousResearch/hermes-agent/blob/939e45c91d751fadd94dcd1b873ac3cb44846213/agent/vault_store.py#L186-L259), [profile behavior](https://github.com/NousResearch/hermes-agent/blob/939e45c91d751fadd94dcd1b873ac3cb44846213/website/docs/user-guide/features/browser.md#L166-L253).

For reusable CLI utilities: use supported pinned binaries, argument arrays, bounded inputs/output/workdir, process-tree cancellation, cross-platform paths/encoding/newlines and schemas. Do not depend on Bash/macOS keychain commands existing on Windows, or use generated shell commands as an authority boundary. Exclude unrestricted shell shortcuts, independent cron/gateways and arbitrary package installers from routine staff execution.

Source: [pinned optional HAR skill](https://github.com/NousResearch/hermes-agent/tree/939e45c91d751fadd94dcd1b873ac3cb44846213/optional-skills/web-development/har-derived-api-client), [existing utility review](REALBUD-HERMES-CAPABILITY-REVIEW-2026-09-13.md). These are source observations, not executed browser/credential tests in this task.

## End-of-life, upgrades and acceptance

Treat session expiry/logout and dependency end-of-life as explicit lifecycle work. Keep a compatibility inventory for RealBud, Electron/Chromium, Hermes, Cua JS/native/manifest, browser backend and Composio toolkit versions. Use reviewed versions, not automatic `latest` on production jobs. A retired or vulnerable capability can be disabled while unrelated workflows remain available. Preserve recoverable work and explain the next repair action; never silently downgrade protection to keep it running.

Updates require source/advisory review, compatibility fixtures, both-platform installed proof, preserved sign-in/permission identity where supported, rollback and an operator-visible result. Do not promise an unverified EOL calendar; dates come from the actual dependency owners and supported-release policy.

| Acceptance group | Required proof |
|---|---|
| Composio | Connect/restart/reconnect/revoke from both OSs; wrong-account/forwarded-link rejection; two personal accounts and one explicitly shared account; locked-action, batch/proxy and schema-drift denial; reconciled result or durable unknown/held outcome after timeout, without duplicate retry. |
| Computer | Matching admitted native stack on Windows and Mac; exact device/app/account/target; Stop/takeover; locked desktop; disconnected and repeated commands; no raw-wrapper/MCP bypass. |
| Browser/session | Existing and dedicated profile paths; same-device persistence; expiry/account change; no cookie/token leakage; profile owner isolation; approved file transfer; clean Forget; replacement-device re-authentication. |
| Website/CLI | Sanitised capture only; no first-tab selection; no secret-filled generated source/output; read/write semantics verified; drift/redirect/CSRF/failure handling; supported executable paths on both OSs. |
| Utilities/lifecycle | Native learning retained; revoked source content excluded; deterministic retry and cancelled child processes; same workflow input/output on both OSs; upgrade/rollback and unsupported capability hold. |

These gates are required dependencies of the three workflows and clean-install acceptance, not optional polish after release. The [implementation register](REALBUD-COMPANY-PLATFORM-TASKS-2026-09-14.md) adds N01–N12 for this scope. No Composio connection, cookie store, driver version, browser configuration, live service or installed app was changed in this planning pass.
