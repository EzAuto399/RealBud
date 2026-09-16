# RealBud GUI workflow and choice review

Reviewed 6 September 2026: onboarding, Desk, Properties/import, Ask, batches, Schedule, You and recovery. Existing local API used for read-only inspection. New records and workflow actions used an isolated service and sample data.

The GUI was presenting configuration and maintenance as everyday work. This pass shows the current task first and reveals optional configuration when requested. This is source/browser verification, not independent PM usability research or an installed release.

## Journey review and changes

| Surface | Finding | Result |
| --- | --- | --- |
| First launch | Existing two-step onboarding already owns the window, with one primary action and a sample escape. The next Desk screen had two Recheck buttons with different behavior. | Kept onboarding. Untouched sample books now have one explicit **Run sample morning** action on Desk. Live books and previously checked samples retain live Recheck. |
| Desk | Three clickable queue counts duplicated the filter toolbar. | Counts live in the five filter buttons. Duplicate sidebar actions are omitted when Desk already provides them. |
| Case review | Decision, evidence and wording are together. Copy announced success before clipboard completion. | Copy now announces success only after completion and reports a manual-copy fallback on failure. Approval boundaries unchanged. |
| Properties/import | Case Queue/Evidence controls appeared where their panels did not render. | Those controls appear only in the case view. Agency setup links open the office section. Import review and authoritative matching/revision checks unchanged. |
| Ask | Six equal examples competed with the request field. Welcome copy pushed examples below the composer at 900 × 600. | Two initial examples: Prepare my day and Prepare an owner update. Four more under More task examples. Short windows use less introductory copy. Examples only fill an empty draft. |
| Batch setup | Three task types and explicit property selection are reasonable; optional instructions made the screen busier. | Optional instructions folded; existing instruction text opens the section. Default task, explicit selection, search, select-all, limits and source scope retained. |
| Batch recovery | Resume competed with Check Bud connection while the worker was unavailable. | Connection recovery is the available primary action. Resume/retry appear when Bud is ready. Saved results and remaining properties retained. |
| Schedule | Automatic planning and writing every step had equal prominence. Unavailable routines looked like daily work. Validation errors offered Reload jobs unnecessarily. | Build my plan is the normal route. Manual planning is disclosed and opens when Bud is unavailable. Planned features are folded and labelled not running. Reload jobs is reserved for load errors. |
| You | Eight office visit fields, six capability descriptions, four setup steps, seven ready-Bud action buttons, credentials, phone platforms and profile fields were exposed together. Morning brief duplicated Desk. | Bud leads with one work action. Completed details, capabilities and repair are disclosed. Office, apps, phone and profile are separate collapsible sections. Go-live is compact; duplicate morning brief removed. |
| Recovery/navigation | Open recovery could open You without revealing recovery. Collapsible settings could hide direct-link targets. | Recovery routes to its exact section. Links reveal enclosing disclosures before scrolling. Office, phone and profile links are now supported too. |

## Choice reductions

- Ready Bud card: seven exposed action buttons to one, excluding disclosure controls.
- Initial Ask examples: six to two; all six remain available.
- Desk queue filters: eight competing buttons to five, with integrated counts.
- Incomplete Bud setup: one current setup item, without the completed/later list.
- Unavailable batch worker: one recovery action instead of competing recovery/resume actions.

## Interactive verification

Browsers reviewed at 1280 × 720 and 900 × 600. The isolated worker was deliberately unavailable; no installer or provider credentials were changed.

| Scenario | Observed result |
| --- | --- |
| Blank onboarding name / invalid optional email | Continue disabled; email error explained. Keyboard clearing restored the optional valid state. |
| Reload onboarding at step two | Resumed office-boundary step; no model/provider selection added. |
| Enter sample Desk | Six training properties, one labelled sample action. |
| Run sample without worker | Produced Demo cases; next header action became Recheck. |
| Review and allow sample wording | Queue count reduced; item moved to Done; licensed case remained held. No message sent. |
| Ask before setup | Drafting available; start disabled; one setup action. |
| Choose example, then choose another | First request staged without execution; second choice retained the existing draft and explained why. |
| More examples | Inbox, maintenance, comparison and research remained reachable. |
| Manual job with missing name | Validation reported missing name and retained context. |
| Save valid manual job | Saved on-demand, awaiting approval; no schedule enabled. |
| Empty batch selection | Prepare disabled. |
| Select six then search with no matches | Six selections retained and summarized before submission. |
| Submit batch with unavailable worker | Saved paused batch with all six waiting items; no output invented. |
| Recovery/app/office direct links | Correct disclosures opened and controls became visible. Recovery key was not revealed. |
| Close/reopen office using keyboard | Unsaved agency field remained in the mounted form. |
| Stop/restart isolated service | Ask showed Reconnecting, kept staged request and disabled execution. Request, saved job and book returned after restart. |

## Automated verification

- `fnm exec --using=24 pnpm test src/lib server/batches.test.ts server/desk.test.ts server/index.test.ts`: **344 tests passed across 42 files**.
- New tests cover settings links, enclosing disclosures and sample-versus-live action routing. Existing tests cover draft preservation, readiness, queue state, job plans, batch failure/retry/revision behavior and API boundaries.
- Production build passed, including frontend/server type checks. Final cleanup also passed type checking.
- Changed tracked files passed focused whitespace checking. Repository-wide checking found an existing unrelated trailing blank line in `src/lib/telegram-channel.test.ts`; left untouched.
- Existing large-chunk build warning remains.
- Logs and turn-specific before/after diffs for You and Bud: `outputs/pm-gui-review-2026-09-06/`.

## Remaining friction and proof boundaries

1. **Provider setup still needs office-level help.** Provider/model selection and a connected-app broker key remain technical. Disclosure reduces distraction, but does not eliminate that dependency. Do not silently choose a paid provider or grant access.
2. **Legacy run labels can disagree with result details.** Installed API history showed Finished beside a missed-check detail, while the week view showed Missed. This pass does not migrate old receipts or reinterpret durable statuses. Normalize receipt outcomes in a separate server/history change with migration tests.
3. **Approval-to-copy could be shorter.** Approved cases move to Done; copying afterward requires returning to the item. A future completion receipt could offer approved wording directly without implying sending.
4. **Portal plans and office fields remain dense when expanded.** Preserve deliberate configuration until a named-office trial establishes which values an administrator can supply once and reuse.
5. **No new live integration proof.** No OAuth, inbox reads, PMS writes, payments, messages or provider-backed job execution in this pass. Existing safeguards preserved. Clipboard rejection handling was code-reviewed; browser denial was not injected.
6. **Installed app unchanged.** Source preview/build verified; no desktop package installed. No claim of complete native coverage or measured PM time savings.

Next usability acceptance: have a PM start the sample morning, prepare an owner update, select several properties and save a reusable job without coaching. Record hesitation, mistaken clicks, time to first useful result and review time. Use those observations before adding more choices.
