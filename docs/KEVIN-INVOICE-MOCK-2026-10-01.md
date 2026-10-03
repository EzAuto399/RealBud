# Kevin invoice mock checkpoint

This checkpoint establishes an installed Bud CSV inspection, not a completed invoice workflow, live REI comparison, invoice entry, payment, session persistence or customer acceptance. A Modelvia request ID has not been joined to the app turn.

## Scope

The owner confirmed Kevin alone handles invoice work. Their latest clarification requires **actual REI reads after the user logs in**, to compare the CSV against real records. All REI writes, edits, entries, attachments, payments and sends remain simulated. The user explicitly rejected the BrowserSkill extension and requested integrating Hermes' native browser capability. Cookies remain in the dedicated work-browser profile; RealBud must not export them or copy tokens. See the [current decision](decisions/2026-10-01-kevin-invoice-rehearsal.md).

## Installed build

Built a local macOS arm64 0.1.26 directory package containing the selected-CSV inspection and managed-access recovery changes from the [core checkpoint](CORE-WORKFLOW-FOUNDATION-2026-10-01.md). The directory package was ad-hoc signed and its signature verified. Package smoke: **1 passed / 0 failed / 0 skipped**, including 69 bundled binary deployment-target checks. This is local build evidence, not a published release.

Stopped the owned 0.1.25 office service using RealBud's authenticated UI, verified port 8799 closed, and quit the app. Preserved a private backup of the stopped workspace and previous app before installing a clean 0.1.26 bundle at `/Applications/RealBud.app`. A first overlay copy failed signature verification because old resources remained; it was preserved separately and never launched. The clean replacement passed verification.

Startup reached macOS SecurityAgent. The computer-use tool explicitly refused access to that system app, so the user was asked to handle its prompt. This hold subsequently cleared: the new service started as PID 37658 with the same workspace instance identity. No credential was read, copied or entered by the agent.

Evidence: [installation receipt](../outputs/kevin-invoice-mock-2026-10-01/installation-receipt.json), [package log](../outputs/kevin-invoice-mock-2026-10-01/package.log), [package smoke](../outputs/kevin-invoice-mock-2026-10-01/package-smoke.log).

## Installed Bud execution

Reattached the selected Property.csv through RealBud's file picker. Bud read the new selected copy and its inspection report, then produced its answer in Ask at 10:30 Brisbane. The report confirms 96 data rows and eight columns; no command-approval prompt occurred. Bud kept sheet statuses separate from REI payment evidence and retained the unknown source freshness. Its extra manual cross-column conclusions were labelled read-through, not deterministic report counts.

The active managed model was `custom:realbud` / `claude-sonnet-5.5` / `sonnet-high`, with a key present. The successful stored readiness ping predates this turn, so it is not claimed as a new check. The actual app answer and new report establish file work; provider request attribution remains a separate evidence gap. See [installed inspection receipt](../outputs/kevin-invoice-mock-2026-10-01/installed-inspection-receipt.json).

Bud then drafted a REI read-only comparison plan, choosing a nine-row coverage sample. The normal **Make this repeatable → Build my plan** path failed schema validation because a model-generated step exceeded 200 characters. No job was saved or run. A bounded correction is being implemented rather than weakening the recipe limits.

Browser setup reached the extension prerequisite. The extension was never installed. After the user's rejection, **Turn browser access off** was confirmed in the installed app; browser state was off/inactive. No REI page was read by Bud and no REI login attempt or write occurred during this original build.

## Native browser replacement

Production source now selects the native Hermes engine through RealBud's typed browser session interface. RealBud opens a persistent private Chrome/Edge work profile. The user signs in in that window, and cookies remain browser-managed in the profile. Task controllers detach on release; normal shutdown closes the owned browser gracefully. No extension is installed or needed, no personal profile is copied, and the package excludes the old BrowserSkill helper.

The existing broker remains the authority for grants, exact websites, account checks, current observed controls and Stop. Validated native accessibility trees retain hierarchy and real references. The current native adapter permits reading and classified search/filter/navigation only; writes and file transfers are unavailable. Mutation-shaped URLs and unknown controls are held. A page's arbitrary GET semantics cannot be proven from its URL alone. Declared account portals require a bound account before any observation; generic custom jobs still need an explicit initial sign-in checkpoint and reviewed portal mapping for account-specific acceptance.

The [disposable native QA receipt](../outputs/hermes-work-browser-host-2026-10-01-graceful-close/receipt.json) proves actual headed launch, process/endpoint identity checks, native snapshot, detach, graceful close and reopen with the same fictional session cookie. It does not establish actual REI login persistence, next-day reuse, MFA, broker-driven native search, Windows operation or a model-led invoice result. REI may require a fresh login whenever its session policy demands it.

The package seals the native engine's final signed bytes and checks them again before use. Root independently reran the actual macOS signing checks: **3 passed / 0 failed / 0 skipped**, [log](../outputs/kevin-invoice-mock-2026-10-01/native-signing-tests.log). Corrected source integration checks: **101 passed / 0 failed / 0 skipped**, [log](../outputs/kevin-invoice-mock-2026-10-01/native-integration-corrected-tests.log). Earlier failures remain in the adjacent first-run logs. Broader regression and packaged/installed results are recorded below when complete.

Job-card shaping now makes at most one bounded correction attempt for malformed/schema-invalid model output, retaining the original request and limits. Operational failures and cancellation are not retried. Website reading and permitted search capabilities can be proposed without granting submission. A corrected card is still an unapproved draft until reviewed normally.

### Packaged and installed native result

The second local 0.1.26 build includes the native runtime, UI, job-card correction and attachment-continuation changes. Build/typechecks passed. The ad-hoc application signature passed verification; package smoke was **1 passed / 0 failed / 0 skipped**, including the actual native engine byte admission, absence of the retired helper, 69 binary deployment-target checks, renderer/service startup and shutdown. See [prepare log](../outputs/kevin-invoice-mock-2026-10-01/native-package-prepare.log), [package log](../outputs/kevin-invoice-mock-2026-10-01/native-package.log) and [smoke log](../outputs/kevin-invoice-mock-2026-10-01/native-package-smoke.log). This is a local build, not a notarized or published release.

Stopped the existing service through RealBud's UI, verified port 8799 closed, quit the app, made a private APFS clone of the stopped workspace and moved the old app into `/Users/yo-da/.realbud-backups/2026-10-01-before-native-browser/`. Installed a clean bundle and verified its signature. A macOS security/keychain hold subsequently cleared; no credential was entered by Codex. Service PID 59750 retains the same workspace identity. The installed resources contain only `browser/hermes-native`.

**Open work browser** initially failed with the host readiness probe's two-second timeout. Failed-connect cleanup left permission off and preserved the profile. A second UI attempt succeeded and visibly showed **Work browser ready**; authenticated API readback confirmed enabled/ready/inactive, engine 0.26.0. The exact underlying Chrome/OS delay is unproved; a future bounded startup-readiness retry remains a possible improvement. No active controller was left attached during login handoff. See [installed native receipt](../outputs/kevin-invoice-mock-2026-10-01/native-installation-receipt.json).

The broader test run finished **6,447 passed / 1 failed / 282 environment-gated skipped** across 480 files ([full log](../outputs/kevin-invoice-mock-2026-10-01/native-full-tests.log)). Its one failure was a synthetic payment refusal, not an unapproved dispatch. The same failure was reproduced with a random-looking reference containing `cad12345`, which the existing currency parser treats as additional CAD evidence. The fixture now uses an unambiguous identifier prefix; explicit coverage retains refusal of the ambiguous reference. Corrected authority/injection tests: **129 passed / 0 failed / 0 skipped** ([log](../outputs/kevin-invoice-mock-2026-10-01/native-injection-regression-tests.log)). The original random value was not logged, so its exact identity cannot be recovered. No production authorization was weakened, and the full suite was not rerun after this fixture correction. Additional first-launch/recovery lifecycle checks: **10 passed / 0 failed / 0 skipped** ([log](../outputs/kevin-invoice-mock-2026-10-01/native-recovery-tests.log)).

### Installed Bud draft retest

Used the ordinary **Make this repeatable → Build my plan** UI after installation. Bud successfully saved **REI read-only check against Property.csv (on demand)**, job `00399f6d-f0e0-4ade-9486-252829948d0a`, revision 1, with 11 bounded steps and the selected CSV reference intact. Its requested capabilities are `read-files`, `analyse`, `draft`, `portal-read` and `portal-prefill`; the only allowed origin is `app.reimasterapps.com.au`, and schedule is null. It includes account confirmation, a bounded sample, payment evidence, separate forecasts/due dates, source references, exceptions and the explicit prohibition on all REI changes and mail access.

This is a persisted **unapproved draft**, not a completed run. The installed managed model remains `custom:realbud` / `claude-sonnet-5.5` / `sonnet-high`. The [draft receipt](../outputs/kevin-invoice-mock-2026-10-01/native-bud-job-draft-receipt.json) corroborates the UI result without copying customer rows. No Modelvia request ID is joined to it. The user was asked to open REI and sign in personally in the separate work window. Actual login, selected account checkpoint, job approval, REI comparison and bill/calendar acceptance remain pending; no live REI change occurred.

## Internal test material and remaining execution

The [fictional evidence packet](../outputs/kevin-invoice-mock-2026-10-01/fixture/fictional-invoice-evidence.md) contains synthetic invoices, duplicated source documents, a conflicting revision, ambiguous property identity, mock REI observations, recurring arrivals and incomplete history. It includes a random reading challenge. It contains no customer rows or precomputed review result. Codex has not analysed the supplied Property.csv as a substitute for Bud.

This fictional packet is now internal regression material, not a replacement for the user's requested real-REI comparison. Once native browser integration is verified and the user has signed in, let Bud lead a scoped on-demand read comparison against the supplied CSV. Require source references, Kevin's exception list, an arrival forecast distinct from due dates and unknowns where history is incomplete. **Rehearse steps** is narration only; it is not evidence that REI was read.

The existing generic saved-job path can persist a prepared report. It does not automatically create accepted bill records or expected-bill calendar entries, and a generic custom recipe lacks the specialised invoice schema checks of the built-in accounts recipes. Report those remaining product gaps separately from any successful document mock.

## Additional source fix

`repeatableJobDescription` now retains complete trailing attachment references when a long Ask request becomes a saved-job description. It keeps them explicitly unverified and requires the existing approved scope; text markers do not grant access. References over the limit receive an omission notice rather than a cut path. Pasted-source and assistant-answer markers are not extracted. Earlier-message attachments and references preceding a final pasted attachment remain a known limit of this text-only transfer.

Local validation, independently rerun by the root agent: **13 passed / 0 failed / 0 skipped**, [test log](../outputs/kevin-invoice-mock-2026-10-01/continuation-tests.log); `git diff --check` passed. This change was initially source-only; it is now included in the second native-browser bundle recorded above, and the installed draft retest preserved the CSV reference.

RealBud's job receipts currently do not carry a Modelvia request ID. A successful installed prepare receipt plus managed-model status and matching provider usage can corroborate actual model execution; neither a ready indicator nor public gateway health alone proves the mock ran.
