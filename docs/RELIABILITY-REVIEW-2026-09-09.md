# RealBud: test the interrupted working day

The useful next question is whether a PM can understand what happened, keep their work, and take the right next step when circumstances change. A green component or service test alone does not establish that complete experience.

## Problems reproduced in this review

Five additional shared-office-status scenarios exposed four failing assertions across three failure modes:

1. A background check finishing after a confirmed account choice could replace that choice. Both a late success and a late failure caused this.
2. A transport throwing immediately could leave a settled request cached, preventing later refresh attempts.
3. An incomplete settings response could leave the previous usable-app display intact.

The status store now supersedes older checks when accepting a settings response, clears usable observations on incomplete responses, and allows a new check after an immediate failure. Server permissions and account validation are unchanged. These are reproduced store-level faults; this review does not claim that each occurred against a live provider.

The fifth new scenario already passed: an older failed request cannot clear the loading state or pending request belonging to a newer check. Keep that regression test alongside the fixes.

The first browser run then caught a regression in the proposed fix: accepting a live status event superseded its matching HTTP check, so the polling owner no longer cleared the sign-in label. The final change settles sign-in from the shared observation itself, regardless of delivery path. A sixth added test covers event-before-response ordering. The failed browser run is preserved under `browser/` rather than discarded.

## Existing coverage worth retaining

The inspected tests already cover lost-response request identity, duplicate submission, failed draft storage, late acceptance preserving newer wording, batch partial success and restart recovery, stale revisions, time-zone schedule behavior, cancelled approvals, unknown external outcomes, selected mailbox binding, malformed provider data, pairing expiry and wrong-chat rejection. Reuse these fixtures rather than building another framework.

`server/office-source-turn.test.ts` verifies contextual-mail eligibility and exclusion. It does not prove that a real worker finds the relevant reply, matches the right property, or writes a useful follow-up. The broker tests verify controlled dispatch against fictional transports; they do not prove a real provider's delivery behavior.

## Highest-value scenarios still needing joined journey proof

These are proposed acceptance cases, not claims that every row is currently broken or absent from every test. Priority orders the next verification work.

| Priority | PM situation | Required user experience | How to test next |
| --- | --- | --- | --- |
| P0 | Two properties share a street name; an owner has several properties; a tenant's name changed | Show the candidate properties and the source of the match. Ask one targeted question when the evidence is ambiguous. Carry the confirmed property through drafts and reviews. | Fictional book and mailbox with deliberate collisions; assert no cross-property evidence or recipients in the output. |
| P0 | A tenant replies while Bud prepares a chase, or an imported rent extract contradicts a newer message | Show source dates and the disagreement. Refresh the relevant evidence before proposing the next action. Avoid a confident chase based on an incomplete or older view. | Replay arrival of a new message between initial read and review; compare output before and after refresh. |
| P0 | PM changes account or removes a source while a read or approval is waiting | The selected account stays visible, later calls stop using the old source, and earlier receipts retain their original source identity. | Delay a fictional response, change the source in another window, then release the response and approval. Check UI and dispatch counters together. |
| P0 | Desktop and Telegram receive instructions or decisions at the same time | Both show the same accepted work and decision. A stale phone card cannot approve changed work; repeated delivery cannot create another job. | Two clients, duplicate and reordered updates, edited approval details and reconnect. Assert one durable outcome for the original request. |
| P0 | A save or approved operation was accepted, but its response disappears | Say what is confirmed and what still needs checking. Recover the original receipt before offering another consequential action. | Drop the response after the fictional service records acceptance, restart the app, then exercise the visible recovery action. |
| P0 | The PM edits a recipient, amount, property or attachment after reviewing a plan | A previous approval cannot silently authorize the changed action. Show the exact current details at the point of approval. | Mutate each field between review and dispatch; inspect actual payload and receipt identity. |
| P1 | The Mac sleeps, loses Wi-Fi, or restarts with an unfinished draft, partial batch or due job | Preserve durable work, distinguish missed work from completed work, and explain what can resume. Refresh connections on return. | First reproduce with isolated service interruption; then repeat with a packaged app on a physical Mac. Browser network simulation alone is insufficient. |
| P1 | A job is renamed, paused, removed or retimed while a run is already active | Explain whether the change affects this run or the next one. Keep completed receipts visible and never quietly replay missed work. | Exercise edits from two windows across a due-time boundary, including a time-zone change. Existing scheduler tests supply the timing fixtures. |
| P1 | A 50-property batch has 30 completed items, one uncertain item and several failures | Retain completed results. Make the remaining scope visible. Separate retryable failures from outcomes needing reconciliation. | Crash after a saved result and after a dispatched operation; confirm the UI's resume action matches the service's remaining-item scope. |
| P1 | An email or attachment contains instructions to ignore the PM, change payment details, or use another account | Treat document instructions as source content. Preserve the PM's chosen scope and require the existing review for consequential actions. | Adversarial fictional messages through the actual worker in an isolated transport. Assert tool calls and output, not just prompt wording. |
| P1 | Microphone permission is denied; an interruption truncates dictation; Enter is used during Chinese input | Keep the text already captured, make recording state clear, and permit a typing fallback. Text composition must not accidentally submit. | Keyboard and IME browser cases, then native microphone permission, audio-device switching and interruption on the installed app. |
| P1 | Storage is full, a file is corrupt, an attachment is huge, or saving recovery data fails | Preserve recoverable work, explain which portion was saved, and avoid claiming that work started when its identity could not be stored. | Inject failures at draft, receipt and batch-progress writes; add a large-file UI case and verify recovery without logging private contents. |
| P2 | A PM has hundreds of properties, long conversations, zoomed text or only a keyboard | Important work remains findable; focus and reading position survive navigation; results do not disappear behind controls. | Populated portfolio walkthrough at 200% zoom, narrow viewport, keyboard and screen reader; measure task completion and response latency. |

## Different approaches to compare

| Choice | Candidate behavior | Evidence to choose with |
| --- | --- | --- |
| Open-ended Ask versus a contextual starting point | Offer “Chase this quote” beside the relevant case, while keeping its wording editable in Ask. | Can a PM finish with fewer corrections and the same verified scope? |
| Automatic recovery versus manual recovery | Retry bounded status reads automatically. For an uncertain consequential operation, reconcile its existing receipt and show the unresolved outcome. | Time to recover, duplicate dispatch count and whether users can explain the result. |
| A long clarification conversation versus a compact choice | Offer two or three identified properties/accounts with a brief reason for the ambiguity. | Correct selection on the first attempt; no guessing from a similar name. |
| Full activity feed versus exceptions first | Lead with the blocked or changed items and provide completed results under a disclosure. | Whether users notice the urgent exception and can still locate the full record. |
| Resuming a batch versus starting a new batch | Show “Continue the 19 remaining properties” using the saved scope and progress. | No repeated completed items; clear handling of removed or newly changed properties. |

## One repeatable acceptance day

Use fictional people, properties and provider responses. Start a quote chase without saying “check email”; connect an account; introduce a same-name property; deliver a new tenant reply; remove the source during preparation; reopen the app; continue on Telegram; review a changed recipient; run a partially failing batch; and return after a scheduled time was missed. Finish by asking the PM to explain what was completed, what was only prepared, what is uncertain, and what needs their decision.

Run the same intent with a short request, a long pasted email, a typo, and a follow-up such as “same for the other property.” Assert the same scope and permission boundaries rather than identical prose. Include a new urgent request during an existing conversation so stale context does not silently choose the property.

Pass criteria: no lost accepted work, no duplicate consequential dispatch, no cross-property or cross-account mixing, no false completion claim, and a usable next step for every interruption. Observe whether the PM can recover without setup instructions from the tester. This review does not establish live-provider, physical-device, accessibility-user-study or office-customer proof.

## Evidence

The new cases are in `src/lib/office-source-store.test.ts`; the bounded fix is in `src/lib/office-source-store.ts`. Before snapshots and the complete failing reproduction log are retained in `outputs/reliability-review-2026-09-09/`. Validation results are recorded there alongside this review; no real mailbox or Telegram operations are part of the fixtures.

- 324 tests passed across 15 targeted files, including the five added scenarios. See `tests.log`.
- After the browser-discovered handoff correction, all 19 office/phone-store tests passed, including the sixth added scenario. See `final-store-tests.log`.
- Production build passed, including both TypeScript projects. Existing bundle-size warnings remain. See `build.log`.
- The final built-browser connection journey passed: automatic fictional OAuth refresh, draft preservation, deterministic inventory, source removal, schedule within Ask, mobile layout, failed refresh and recovery, and no browser errors. See `browser-final/result.json`. This walkthrough uses a fictional provider and performs no mailbox operations.
