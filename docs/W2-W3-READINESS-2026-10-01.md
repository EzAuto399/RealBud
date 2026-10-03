# Kevin W2 and W3 readiness — 1 October 2026

This checkpoint distinguishes installed Hermes interpretation, source-build UI testing, and live office acceptance. Kevin remains the accountable invoice reviewer. W1 still needs his original and corrected bank-reference examples.

**W1 clarification:** its full target now includes user sign-in, bank CSV export every two days, reference review, verified REI preview, user receipt posting and Bud readback. The [W1 operating model](decisions/2026-10-01-w1-bank-to-rei-workflow.md) records the remaining native file transfers, interval runner, overlap reconciliation and import checkpoints. Example files alone do not close those implementation gaps.

**Owner clarification after the rehearsal:** both routines use the user's connected Composio Gmail account. W2 is a weekly bill review with internal calendar/follow-up updates and user notification; W3 is the daily before-work priority list. The supplied CSV is an example/reference, not the recurring trigger or an import prerequisite. See the [accepted Gmail operating model and implementation gap](decisions/2026-10-01-gmail-w2-w3-operating-model.md). The weekly W2 orchestrator and result-specific notifications are still unwired; the tests below do not claim that automation is complete.

## Rehearsal results

| Workflow | Result | Evidence limit |
|---|---|---|
| W2: supplied Property.csv + six fictional invoice sources | Installed Bud handled exact, ambiguous and missing matches, forwards, conflicting versions, source-status disagreement and a tentative arrival forecast. All six reasoning cases passed independent evaluation. | The CSV is real; invoice, history and financial observations are fictional. No real REI state was established. |
| W2: bill acceptance and calendar | In an isolated source-build UI, saved one fictional bill, corrected its dates with history, and kept the actual due date separate from six predicted arrival windows. Forward identity triggered review; a conflicting version had no separate-invoice override. | Generated mailbox and deterministic proposal worker. This is persisted UI behavior, not a second live model extraction test. |
| W2: financial review and recovery | Real UI rejected CSV-only financial claims, saved an encrypted financial draft, and restored all fields after a service restart with confirmation cleared. A simulated claim saved at revision 3; a status-only correction retained it at revision 4; a material correction at revision 5 showed all current states as Unknown and retained the earlier claim. | Fictional external-account evidence. No payment, funding or advance state was established for a real account. |
| W3: complete and partial morning scopes | Installed Hermes returned two source-bound Prepare receipts covering 14 complete-scope and 12 partial-scope conversations. Production parsing/validation and the unchanged 32-check scenario oracle passed. | The latest result is an Ask rehearsal validated offline; it is not a saved production W3 run or acceptance of Kevin's mailbox. |
| W3: pipeline behavior | Isolated HTTP/composed tests cover 45 conversations in 20/20/5 batches, repeats without extra model calls, kept reviewer decisions, reopening for new replies, partial failures, history and missed-run handling. | Fictional connector/worker test data; source behavior rather than live office coverage. |

Actual installed model selection was Hermes / `claude-sonnet-5.5`. The transcript capture does not include file-tool telemetry or provider request IDs; file-read-completeness claims remain model self-report. The W3 output nevertheless contains the correct separate source scopes, source IDs, chronology, missing-evidence holds and no fabricated actions.

W3's first two Ask interpretation passes, supplied with incomplete production context, failed some routing and urgency checks. These do not establish a defect in the full production urgency policy. The final packet used the full actual production Prepare prompt and support instructions. No scenario answer was included and no expected result was weakened. The source clarification distinguishes the invoice workflow destination from Kevin/accounts-reviewer accountability.

## Product changes

- Reviewed invoice number/version now survive drafts, acceptance, corrections and backup. Same-property/vendor invoice identity detects forwards and PDF-only duplicates; conflicting versions or facts hold separate acceptance. Vendor labels remain review candidates, not proven supplier identities.
- Legacy missing invoice fields and new explicit nulls compare semantically. Status-only corrections preserve old stored facts and audit hashes. Older draft clients cannot silently omit reviewed identity fields.
- Separate human-reviewed entry, payment, funding and advance states are now represented with actual/simulated provenance, evidence references, account context, observation time and scope. CSV status alone cannot establish these states. Unknown stays available.
- Financial reviews use existing encrypted drafts, revision/source guards and immutable bill history. Facts/source corrections invalidate the current financial claim; historical claims remain available. A reviewed claim is not independent connector verification.

Final focused validation passed **281 tests across 15 files**, with zero failures or skips. The UI rehearsal exposed an extra-field mismatch between financial drafts and the encrypted store; explicit field projection fixed it, and a real-store create/edit/reopen regression now covers the boundary. The final UI acceptance above was performed after that fix.

The separate Mac candidate passed Node 24 builds, strict signature verification, all 69 native deployment-target checks, renderer/service startup and shutdown. Its manifest includes the whole current runtime checkout and preserves the installed native runtime bytes; it is not a selective W2 patch or a notarized release.

At 15:30 Brisbane, the verified candidate replaced `/Applications/RealBud.app` after an idle check, ordinary UI service stop, desktop quit and hash-verified offline backups. The installed app exactly matched the candidate manifest and passed strict signature verification. The previous app and workspace/profile/log backups are retained in `/Users/yo-da/.realbud-upgrade-backups/2026-10-01-w2-w3-1790832304666/`. Startup initially waited at a protected macOS security prompt; the agent did not access or bypass it. At 15:38, the new service was verified running with the same workspace identity, the expected served renderer and compiled runtime hashes, all 46 workflow records and unchanged schedule metadata. Readback retained 10 mail items, 4 jobs, 6 loop runs, 1 bill draft and zero accepted bills/series. Native UI independently showed App connected, Bud ready and Kevin's bill/calendar view with its saved draft. This proves upgrade continuity, not business workflow acceptance.

The subsequent Gmail operating-model clarification is staged in **source pack revision 5**, separate from this installed candidate. Its preparation instructions do not implement the missing weekly orchestrator or activate a schedule.

## REI login and execution

The installed on-demand job `00399f6d-f0e0-4ade-9486-252829948d0a` was updated through ordinary UI to revision 2 and reapproved at revision 2. Its schedule remains null. Steps 3–4 require user client sign-in and fresh agency/account confirmation for each attended run, then validation of the REI origin, URL `reicid` and visible business code. Neither the CSV nor an earlier session is confirmation. Bud does not enter credentials or force logout.

This is an instruction-level checkpoint. Live account binding, portal semantics and a completed comparison still require the user to sign in. Current REI writes, imports, attachments, payments and sends remain simulated. The installed bill register remained at zero occurrences and zero recurrence series after the model rehearsals; synthetic saved bills are confined to the isolated test workspace.

Hermes provides the Bud worker and the existing attended browser path. Generic background Prepare does not itself supply portal browser execution. Hermios CRM authentication and multi-department execution remain a separate integration milestone; this work does not claim that the CRM adapter is mounted or that every Hermes feature is enabled.

The existing paths are ready for controlled integrated rehearsals. To close the clarified Gmail-first milestone, W2 needs a dedicated weekly collection/preparation runner, persisted coverage-aware arrival findings, internal calendar/follow-up handoff and a result-specific notification. W3 has its daily runner and needs the selected timing, result notification and installed scheduled acceptance for the intended account. REI comparison and native CRM work remain separate integration gates, not prerequisites for the Gmail-first milestone. W1 reference examples are therefore not the only remaining acceptance input. The [completion plan](WORKFLOW-INTEGRATION-CLOSURE-2026-10-01.md) retains the broader integration and W4/W5 work.

The next CRM milestone is authenticated RealBud company/member-to-Hermios workspace binding, scoped native record reads and explicitly selected Bud context. Then prove one department handoff, followed by concurrent department work and a narrow reviewed CRM effect with conflicts and lost-reply recovery. The Codex plugin connection cannot supply RealBud's account authority; Hermes child delegation does not create a department identity.

## Evidence

- [W2 independent installed-model evaluation](../outputs/w2-w3-readiness-2026-10-01/w2/installed-model-evaluation.md)
- [W2 isolated UI identity and calendar receipt](../outputs/w2-w3-readiness-2026-10-01/w2/isolated-ui-identity-receipt.json)
- [W2 financial UI, restart and correction receipt](../outputs/w2-w3-readiness-2026-10-01/w2/isolated-ui-financial-receipt.json)
- [Financial source validation](../outputs/w2-w3-readiness-2026-10-01/w2/financial-review-source-validation.md)
- [Installed REI plan revision and counts](../outputs/w2-w3-readiness-2026-10-01/w2/installed-rei-login-plan.json)
- [W3 final model evaluation](../outputs/w2-w3-readiness-2026-10-01/w3/installed-model-evaluation-v3-receipt.json)
- [W3 simulation and contract checkpoints](../outputs/w2-w3-readiness-2026-10-01/w3/README.md)
- [Hermes capability audit](../outputs/w2-w3-readiness-2026-10-01/hermes/capability-matrix.md)
- [Final 281-test receipt](../outputs/w2-w3-readiness-2026-10-01/final-tests-receipt.json)
- [Mac candidate verification and upgrade boundary](../outputs/w2-w3-readiness-2026-10-01/candidate-package-verification.md)
- [Verified local installation, startup continuity and rollback](../outputs/w2-w3-readiness-2026-10-01/local-upgrade-checkpoint.md)

Private W2 packet and response are kept outside the repository at `/Users/yo-da/.realbud-rehearsals/2026-10-01/`; public receipts omit customer addresses and financial reference values. The CSV hash/row-count oracle and the final model evaluation are independent of Bud's input.
