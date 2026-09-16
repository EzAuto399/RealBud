# Bud identity, daily work and connected-app control

6 September 2026. Source implementation and local verification. The installed app was not replaced.

## What changed

- One shared Bud identity now reaches both interactive Hermes turns and the preparation worker used for jobs/batches. Bud is the assistant, RealBud is the application, and Hermes remains the independently managed runtime. Technical explanations and quoted source material retain accurate names.
- The property profile describes useful PM work beyond arrears: inbox triage, maintenance follow-ups, inspection preparation, owner updates and invoice comparisons. Instructions favour finished preparation, source dates, grouped property results, explicit exceptions and reusable jobs.
- Ask has six editable task starters. Returning users can find them under **Tasks, book & saved jobs**. Choosing one closes the drawer and focuses the composer; it neither submits the request nor replaces an existing draft.
- Connected-app shortcuts in You use canonical Ask. The previous implementation called connector routes that product mode denies and silently discarded status errors. The new path uses the existing submission/error handling and preserves unsent composer work.
- Routine setup feedback and model labels use Bud. Underlying runtime identifiers, paths and independently installed software are retained.

## Authoritative app boundary

The previous real-Hermes negative control showed a write-capable MCP tool reaching its endpoint without an approval request. That specific path is now closed by a RealBud-owned loopback broker mounted in place of the direct upstream MCP connection.

- The worker receives a private local broker token, not the upstream Composio credential. Ambient `COMPOSIO_KEY` is removed from worker environments; upstream credential echoes are redacted from tool results.
- Only explicit discovery/schema operations and list-only connection status run without review. Unknown tools and read-looking names still require review; upstream `readOnlyHint` does not grant authority.
- Review binds the complete request. A mixed batch of up to 50 direct tool operations has one review covering the whole batch. Deny forwards none of it. Nested Composio meta-tools and malformed/oversized batches are blocked.
- Remote workbench/bash and account changes through the model's connection-management tool are unavailable. Explicit sign-in remains a separate canonical Ask workflow.
- Approval is once only. Full-auto mode, standing rules, browser-rule heuristics and task/session grants cannot bypass this app checkpoint. The UI does not offer a task-wide or permanent grant for it.
- Waiting requests are cancelled on stopped turns/disposal. The active turn is checked again after approval. Unsupported capabilities, browser-origin requests and invalid local tokens are rejected.
- Duplicate transport requests share their result; changed arguments cannot reuse an ID. Denied or uncertain operations are not automatically retried. Request and response sizes, concurrency, request count, cached responses and transport duration are bounded. Cache pressure retains an operation tombstone rather than evicting its identity and replaying it.
- Approvals and resolutions use the existing Ask event stream and pending-approval UI. This is a transport enforcement boundary, not only an instruction to the model.

## Verification

- **Full suite: 1,111 passed, 8 skipped, 133 files passed.**
- Production frontend build and TypeScript checks passed. Build still reports its existing large-chunk warning.
- Real independently installed Hermes: MCP initialization, discovery, authenticated fixture read, unpredictable source reference, quote difference, missing access fact and credential redaction passed.
- Real worker identity check: responded as **Bud**, not Hermes or RealBud.
- Repeated write-gate negative control: **1 permission request; 0 calls to the inert write endpoint; 0 real writes. Passed.**
- Focused regression coverage includes full-auto/session-grant rejection, mixed batches, duplicate IDs, changed arguments, concurrent duplicate delivery, denial, cancellation, stale turns, invalid input, provider failures and credential echoes.
- UI observed at 1280×720 and 900×600: returning-user starters visible; one starter fills the composer without starting work; a second starter preserves the original draft with a clear notice; task drawer collapses after selection. Temporary test draft was cleared through the UI.
- Scoped diff checks passed. Existing user/parallel workspace edits were preserved.

Evidence: `outputs/pm-integrations-2026-09-06/bud-full-suite.log`, `bud-build.log`, `bud-broker-canary-final.log`, and `bud-final-tests.log`.

Reproduce the real worker check with:

```sh
fnm exec --using=24 node --experimental-strip-types scripts/qa-connected-apps.mjs --probe-write-gate
```

The test approves only its fictional read fixture and denies the write probe. It creates a disposable RealBud workroom and loopback server; it performs no office-system action.

## Limits still requiring office proof

- RealBud's installed configuration has no Composio key. Live OAuth, provider scopes, named account selection, pagination and complete PM workflows have not been proved against an office account.
- This broker gates the mounted MCP path; it is not a claim that Hermes is an operating-system sandbox or that all possible communication channels have been audited.
- Real account binding and provider-state reconciliation after an uncertain write remain required before a live write pilot. The duplicate cache is session-local, not a durable provider action ledger across app restarts.
- App execution currently needs exact review even for reads outside the narrow discovery allowlist. More automatic reading should come from verified, account-scoped read policies, not naming heuristics or blanket grants.
- Desk batch preparation still consumes supplied snapshots. This change does not silently add connected mail/calendar access to that worker or claim ongoing monitoring.
- Identity is enforced through common entry-point instructions and checked against the real model. Historical transcripts are not rewritten, and generative output cannot be promised infallible.
- Source and local-runtime proof are distinct from a newly packaged/installed release, live-office acceptance and external-action confirmation.
