# Agency workflow setup and saved mail work

The private installation owns its agency setup, source selection and saved work. Joining an office or a department does not connect an account, authorize a read, or transfer this private workspace to another installation.

## Saved setup

`shared/agency-setup.ts` defines the versioned settings. `server/agency-setup.ts` stores them in private `agency-setup.json`, bound to the existing workspace identity. It holds the agency name, explicit IANA timezone, selected Gmail account identifier, bounded mail scope, property-reference directory, selected workflows and morning preferences. It stores no passwords, tokens, provider keys or machine-specific paths.

The mail scope defaults to seven days, at most 100 messages, including sent messages, with attachment metadata only. The operator can choose 1–90 days and 1–500 messages. These defaults do not enable a schedule or authorize a source read. The source collector receives the saved scope; message text cannot widen it.

The agency explicitly selects `workflowPackId`: `office-core`, `austin-office`, or no pack. Legacy settings without this field read as unselected without changing their saved bytes. `shared/agency-workflow-packs.ts` resolves known pack IDs and recipe roles; title matching, first-installed selection and caller-supplied plan IDs are not selection mechanisms. Selecting another pack clears reviews. The independent office core pack has separate published JSON, plan IDs and native instruction namespace; Austin bytes remain unchanged.

Settings use optimistic revision checks. Changes clear all setup approvals. Missing files represent first use; malformed, unreadable, oversized, symlinked or foreign-workspace files are preserved and hold mutations for recovery. Identical saves preserve existing reviews and bytes. Property references must identify currently available properties and must be unique after normalization. Ambiguous payer aliases remain matching hints, not permission to choose a transaction reference.

## Readiness and review

The host injects existing observations. Checking status does not call an account or model. A separate explicit check is bound to the saved Gmail selection. A connected label or configured boolean alone cannot satisfy private account verification.

Each workflow review binds the settings revision and an evidence digest covering the current source authority, plan/adapter and relevant property directory. Execution admission checks current prerequisites, that review and a second saved revision read after asynchronous observations. Gmail verification must identify the exact selected active account, its authority binding and a check within five minutes.

Setup approval permits the reviewed operation to be admitted when its current execution prerequisites pass. It does not require prior real-customer acceptance merely to read that reviewed scope. Source coverage and customer acceptance are separate displayed checks. A business acceptance receipt must bind both settings revision and evidence digest; changing source authority or the plan invalidates the displayed acceptance.

No setup action enables scheduling, sends messages, downloads attachment contents, changes provider permissions, pays bills or performs a final accounting import. The server's integration explicitly pauses the morning schedule after changed agency settings. Enabling that schedule is a separate action using reviewed timezone, local time and weekdays.

## Integration seams

`createAgencySetupService` takes a private directory, trusted workspace/actor identities, a read-only `observe(settings)` callback and an optional bounded `checkGmail(accountId, settingsRevision)` callback. `getConfiguration()` reads settings without invoking observations, avoiding observation recursion. `assertWorkflowReady(workflow, expectedReview?)` returns the admitted settings, revision and digest; a caller can retain and recheck that binding around asynchronous work.

The service handles:

- `GET /api/agency-setup`: settings and observed checks.
- `PUT /api/agency-setup`: `{expectedRevision, settings}`.
- `POST /api/agency-setup/check-gmail`: `{expectedRevision}`.
- `POST /api/agency-setup/workflows/:id/review`: `{expectedRevision, expectedEvidenceDigest}`.

The main server remains responsible for session authentication, private worker scope, account authority and recovery guards. `AgencyWorkflowSetup` is mounted in the existing workflow pack card. Its draft is kept separately from refreshed checks; stale server revisions block saving until explicitly reloaded.

`MailWorkPanel` shows a compact summary in Desk. Open mail priorities explicitly creates, reuses or unhides a private saved mail view within the existing view limit. That full view has its own scrolling area, saved filter, coverage receipts, running review state, and persistent attention/waiting/reference/snoozed/done groups. Operators can preserve a local owner, priority, next action and note, review plain saved message text, and mark work done. Opening an editor or source brings it into view and moves keyboard focus there. Source markup is rendered as text; no remote images or attachment content is loaded. A changed source reopens an item and flags new evidence while retaining human decisions.

The panel submits a review with a UUID and current schedule revision. An uncertain response is reconciled against the saved request ID; explicit retry keeps that same request. A running collection or review disables duplicate starts. Model preparation is distinct from collection, and the panel never interprets a failed or partial scan as an empty inbox.

## Verification and limits

`server/agency-setup.test.ts` covers first use, restart, idempotence, revision races, forged verification and credentials, bounds, foreign account/property mappings, normalization, revocation, expired checks, corrupted bytes, source/plan drift, and acceptance binding. These are local unit tests with injected observations.

`scripts/qa-agency-mail.mjs` renders the production React components against actual agency and encrypted mail stores with fictional source and queue adapters. It exercises setup, scope review, saved edits, safe source rendering, changed evidence, uncertain request reconciliation, explicit scheduling, reload and narrow layouts. Its receipt and screenshots are written to `outputs/agency-mail-2026-09-21`. This harness is not proof of a live provider, paid Hermes run, installed desktop or customer acceptance.

The real adapters, runtime readiness and approved plans must supply current observations. A reviewed setup can still be held by revoked access, unreadable state, changed instructions, an unavailable worker, incomplete source coverage or missing business facts. Those conditions remain visible rather than becoming claimed readiness.

## Source-bound invoice preparation verification

`server/bill-proposals.test.ts` independently checks the host's selected-message preparation boundary with the real encrypted workflow database and a deterministic local executor. All 23 tests passed on 21 September 2026, followed by the whole-project typecheck. The receipt is `outputs/bill-proposals-2026-09-21/unit-receipt.json`.

Preparation persists a request identifier and source/authority binding before dispatch. The executor claims the recipe before writing its private input. Replaying a request rechecks current source access and plan authority, then returns its existing job receipt without invoking the worker again. Source reads follow asynchronous authority checks, including the final check before exposing results. A synchronous host generation binds the entire request: a source or authority mutation while a read is pending holds both preparation and replay. The tests distinguish reserving a job from dispatching the worker, and verify changes during the final input check prevent dispatch. Typed result validation rejects output for a different document or recipe revision. Missing attachment contents remain explicit holds; this input never asserts whole-inbox coverage.

The regression cases cover UUID normalization, request conflicts, concurrent admission, unchanged active input when another run claims the plan, interrupted intent recovery, source changes during authorization, authority changes after dispatch, malformed output, and mismatched job revisions. No test creates an accepted bill, recurrence, provider action or payment. This proves the local boundary and retry behavior with an injected executor; it does not prove a live Gmail read, a paid Hermes invoice interpretation or customer acceptance.
