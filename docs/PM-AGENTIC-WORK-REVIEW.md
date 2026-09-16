# PM work completion and reuse

Second walkthrough on 5 September 2026, following [the daily experience review](PM-DAILY-EXPERIENCE-REVIEW.md). This report covers the current source tree, the local browser and real Hermes calls with fictional inputs. The installed desktop package has not been replaced.

**Subsequent desktop verification:** [the desktop review](PM-DESKTOP-REVIEW-2026-09-05.md) records the later signed rebuild, native walkthrough, two additional recovery fixes and installation into `/Applications/RealBud.app`.

## Outcome

A PM can ask for a usable result, turn the task into a reviewed job, update its inputs for another run, and continue from a prepared result with its sources attached. The emphasis is on removing repeated drafting, comparison and explanation work.

| Friction found | Improvement |
| --- | --- |
| “Draft an owner update” and requests mentioning the morning could receive a fixed Desk reply before reaching Hermes. | Narrow status shortcuts preserve quick Desk answers while preparation, comparison, research and multi-step requests reach the worker. |
| “Do not read files or websites” in a drafting request could create an unintended portal job. | Preparation requests, negative instructions and quoted attachments no longer trigger the implicit portal shortcut. Explicit named-portal jobs retain their existing path. |
| Prepared outputs were clipped to 500 characters in both parsing and saved receipts. | Complete output is retained up to 12,000 characters per output and 32,000 overall. Oversized results fail explicitly instead of becoming silently incomplete reports. Diagnostics retain their separate bounds and redaction. |
| The PM had to reconstruct a successful task in Schedule. | **Make this repeatable** carries the request and an explicitly labelled example into an editable plan. It preserves an unfinished plan, starts on demand by default and retains plan review. |
| A saved job's description could not be updated from the plan editor. | **Inputs and context** lets the PM replace old examples or name current sources. Saving changed facts creates a new revision and requires renewed approval. |
| Continuing a result meant copying it and re-explaining the job. | **Continue with Bud** attaches the complete result, goal, date, revision, sources and held steps. It preserves an existing Ask draft and attachments, deduplicates repeated selection of the same receipt and never starts a turn automatically. |
| The result attachment hid its title and showed internal instructions in a large preview. | A compact attachment shows the job title and opens for review. Its remove control stays visible and keyboard accessible. |
| Several large results could exceed the Ask request limit after attachment wrapping. | The composer and API share the 50,000-character envelope limit. The composer explains how to shorten an oversized request and keeps its text and attachments. |

Hermes is instructed to complete useful work using available sources, ask only for information that blocks progress, check calculations and return a usable result. Completed work remains reference material; earlier facts and approvals do not become new authority.

## Real worker evidence

| Task | Observed result | Scope |
| --- | --- | --- |
| Read two maintenance quote files and prepare a comparison and owner update | The worker reproduced a random reference present only in the files, both source filenames and the AUD 1,375 / 1,485 totals; it calculated the AUD 110 difference. The 2,152-character output survived reopening the result store unchanged. | Real Hermes file tools and provider; fictional documents in an isolated workroom. |
| Draft an owner update in Ask | Two usable paragraphs and the required owner decision, using the supplied AUD 1,375 quote and unconfirmed access. | Live local browser and real provider; no external communication. |
| Make the task repeatable | A real model-generated plan was saved, reviewed, approved for on-demand use and run. Its prepared output and held steps appeared in Work activity. | Existing plan and execution APIs; fictional facts. |
| Continue from the result | An existing request survived the handoff. Selecting the same receipt twice left one attachment. Hermes then shortened the owner update to under 70 words while retaining the quote, access status and owner decision. | Live composer, real provider and attached result context. |
| Reuse with updated inputs | Changing the quote to AUD 1,250 and access to Tuesday morning required saving and approving revision 2. The next real result used those updated facts; the revision 1 receipt remained available. | Live plan editor, authoritative revision checks and real preparation. |
| Resume conversation context | The real ACP contract retained a fictional reference through a warm follow-up and a fresh worker process supplied with the prior transcript. | Automated real-provider canary. |

`scripts/qa-hermes-contract.mjs` now includes the document comparison, unpredictable source reference, arithmetic, long-output and durable-reload checks alongside readiness, plan drafting, rehearsal, exact revision approval and duplicate-run checks.

## Verification and recovery

- Full Vitest run: **994 passed, 8 skipped, 128 files passed**. After the final input-editor addition, **89 focused tests passed** across plan editing, context transfer, recipes, job execution and the server API; this included one new input-editing test.
- Native Node tests: **12 passed**, covering release artifact promotion/recovery and enquiry storage/retries. Vitest now merges the existing application configuration so it uses the intended test discovery, isolated setup, aliases and file execution order. Native `node:test` files run with their own runner. The Discord test now checks raw request routing plus preserved channel attribution and relay handling.
- All five PM HTTP regression suites passed: Desk, PM day, PM exceptions, portal jobs and walkthrough. The changed portal suite was rerun after the live-discovered negative-instruction case and passed with zero skips.
- Frontend and server TypeScript checks and the production Vite build passed with Node 24. The final input-editor change was followed by another frontend check and production build.
- Parser/store tests cover complete long output, individual and combined size limits, receipt reopening and recovery after a rejected oversized settlement. Validation happens before a run's status changes.
- Context tests cover sources and held steps, exclusion of rehearsal/running results, draft/file preservation, duplicate handoffs, bounded plan descriptions and the complete Ask envelope limit.
- Browser checks at **900 × 600** covered editable inputs, review and approval, result inspection, compact attachment expansion, preserved drafts, duplicate handoffs and completed real-provider follow-ups. A 54.7 KB synthetic paste was rejected before starting work and remained attached for editing.

No customer records, live portal operations, external messages, installer changes or Hermes profile changes were used in this pass. Existing source changes from other work were preserved.

## Remaining evidence limits

The real checks prove the specific document, drafting, reuse and continuity paths above. Public-web research quality, vision, delegation, historical session search, customer-connected apps and live-office workflows still need their own outcome tests. Configured toolsets are not evidence that every capability has been exercised.

Fresh input is still required: the new editor makes updating facts possible, but it does not automatically connect missing PMS/inbox sources or guarantee source freshness. Long-output preservation applies to newly saved work; it cannot reconstruct text already truncated in an old receipt. Vite still reports large bundle chunks, and no latency or agency time-saving benchmark is claimed.

RealBud continues to own the PM workflow, scheduling, review and receipts. Hermes remains independently managed. Consequential external actions retain the existing permission boundaries. The next customer proof is one named PM completing the same representative workflow several times while measuring input, review and correction time.

## Browser evidence

All screenshots show fictional training work.

![Prepared work from updated inputs](../outputs/agentic-walkthrough-2026-09-05/reused-job-fresh-facts-900x600.png)

![Continuing with a result and an existing draft](../outputs/agentic-walkthrough-2026-09-05/continue-with-context-900x600.png)

![Editing inputs for the next run](../outputs/agentic-walkthrough-2026-09-05/editable-job-inputs-900x600.png)
