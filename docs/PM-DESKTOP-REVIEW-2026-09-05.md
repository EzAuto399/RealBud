# RealBud desktop review — 5 September 2026

This pass verifies the changes from [PM work completion and reuse](PM-AGENTIC-WORK-REVIEW.md) in a freshly built macOS app. All walkthrough inputs are fictional, stored in a separate RealBud data directory. Hermes remains independently installed and configured.

## Findings fixed

| Finding | Fix | Evidence |
| --- | --- | --- |
| Ask cleared the request and attachments before the server accepted them. A failed submission could lose the user's work. | A normal Ask submission keeps its complete draft until acceptance. Failures retain it with an explicit recovery message. A late acceptance checks the submitted snapshot before clearing, including after navigation. | Unit tests; blocked request in the packaged renderer; full reload; delayed 202 response while replacing the draft and attachment. |
| The native Schedule walkthrough produced a valid owner-update receipt followed by one extra `}`. The reader rejected all of it. | The JSON reader extracts complete objects while respecting quoted text, escaped characters and nested objects. It does not rewrite malformed fields or bypass the receipt schema, size limits or held approvals. | The original fictional reply fails against the first package and passes against the fixed source. Regression tests cover this exact shape, nested schedules, code fences, malformed fields, truncated objects, oversized output and missing approval information. |
| The real Hermes package test defaulted to an older build, and its vault import still came from source. | The test accepts an explicit `--packaged --app` path; the selected bundle supplies all production modules, including the vault. | The real canary runs under the selected app's Electron executable. |

The first source check also found a server TypeScript incompatibility in a proposed DOM event notification. It was replaced with a small in-process subscription; the subsequent complete package builds pass both TypeScript checks. The initial failure log is retained.

## Walkthrough

1. Open the packaged sample desk and complete the private Hermes readiness check.
2. Use keyboard navigation to Ask. Block only its submission endpoint: the request fails visibly and the text and attachment remain. Restore access and reload: both remain available.
3. Hold a real 202 acceptance response. Navigate away and back, replace the request and its attachment, then release the response: the newer draft survives. All request interception is removed afterward.
4. Produce a real owner update from the fictional AUD 1,375 quote and unconfirmed access. The native app shows a complete draft and **Make this repeatable**.
5. Carry the request into a job plan, change the current inputs to AUD 1,250 and confirmed Tuesday morning access, and edit the steps to use the current access status. Save revision 2 and approve it for on-demand preparation.
6. The first native preparation fails visibly because of the extra closing brace. Its failed receipt is preserved for the review; the exact model response is replayed to prove the reader fix.
7. Restart the final signed app, reopen the same approved revision 2 and prepare again. The full owner update appears with AUD 1,250, confirmed Tuesday morning access, three source observations and the held human sending step. The old failed run remains visible.
8. Select **Continue with Bud** and request a warmer update under 50 words. The attached result carries revision 2 and its sources. The native composer clears only after acceptance; the real reply retains AUD 1,250 and Tuesday morning access. No contact or external change occurs.

Generated steps also need review when an example contains changeable facts: the first generated plan embedded “access is unconfirmed” in a step. The walkthrough updates both the inputs and that step. Editing inputs alone does not automatically rewrite contradictory saved steps.

## Validation records

Logs and fictional screenshots are in [the review evidence folder](../outputs/desktop-review-2026-09-05/).

- Initial full suite: 998 passed, 8 skipped, 129 files passed.
- Final JSON-reader focused run: 46 passed across job execution, recipe drafting, recipe storage and shadow sessions.
- All five PM HTTP suites passed: Desk, PM day, PM exceptions, portal jobs and walkthrough.
- Native Node tests: 12 passed. Electron syntax check passed.
- First signed package: renderer/preload capabilities, embedded server and shutdown smoke passed; strict deep signature verification passed.
- First packaged real-Hermes canary: provider ping, plan drafting, rehearsal, exact revision approval, preparation, idempotent duplicate handling, receipt reload, real file reading, quote arithmetic, complete 2,549-character output, warm follow-up and fresh-process transcript recovery all passed.
- Final full suite after both fixes: **1,002 passed, 8 skipped, 129 files passed** (`tests-final.log`).
- Final package build: frontend/server typechecks, production UI, compiled server, native helpers and Developer ID signing passed (`build-final.log`).
- Final package smoke and strict deep signature verification passed (`package-final-smoke.log`, `signature-final-verify.log`).
- Final real-Hermes canary under Electron 43.4.0 passed the complete contract again, including **2,698 characters** of preserved quote-comparison output (`packaged-final-hermes.log`).

## Scope and remaining limits

These checks prove specific local and fictional workflows. They do not establish live PMS/portal/inbox operation, customer time savings, every Hermes capability, or a paid-office pilot. No external messages or record changes were performed. No Hermes installation, profile or credential settings were changed.

Draft recovery in this change covers normal one-to-one Ask submissions. Browser storage remains best-effort when unavailable or over quota. The user still reviews uncertain requests before retrying. Generated plans and model outputs still require checking for missing facts and contradictions.

This is a local Developer ID signed arm64 build. The package command explicitly skips notarization; this report is not a public-distribution attestation. Vite's existing large-chunk warning and irrelevant platform optional-dependency warnings remain in the build logs.

The two builds' stylesheet sizes were 75,220 and 86,704 bytes. The source uses Tailwind's automatic discovery and QA outputs are not ignored; those outputs are a likely source of extra unused rules. Investigating and restricting discovery is a nonblocking build-size follow-up. Byte-identical renderer output across these two builds is not claimed; the final renderer was walked through separately.

## Installed result

- Installed and opened **`/Applications/RealBud.app`**, version **0.1.17**, arm64, Electron **43.4.0**. No existing app occupied that path. Installation staged and verified the copy before moving it into place.
- The installed bundle's **767 regular-file/symlink entries match** the final package, including file contents, file permissions and link targets (`installed-identity.json`). The installed app independently passes the renderer, capabilities, embedded-server and shutdown smoke (`installed-smoke.log`).
- Developer ID: **Yo-Da Lai (4F4SMS88P8)**. Final CDHash: `deca3c360ce0046c18de636022fef13395707fc5`. Signed 5 September 2026 at 11:08:33 pm Brisbane time. Notarization was skipped.
- Final DMG SHA-256: `f273ebbc1ad8c53c2a46448a9390878c73386d6291cff97444407fabc1a31d86`.
- Final ZIP SHA-256: `8a275fb13b4dcaa4cdbd7ded6bdd1e7298c37c4924dd75eb19cf26b320429d82`.
- The installed app reopened the user's existing settings and conversation. Its private readiness check passed at **11:19 pm**, and it is left open in **Ask — Bud ready**. The existing Desk's missed 4 September check remains historical evidence; this pass did not rerun or rewrite that book's facts.
- Test browser interception was removed, the test tab closed, and the isolated native app quit. The ordinary installed app is the remaining RealBud process. The worktree's unrelated changes remain in place; no release was published.

![Final native continuation using the updated result](../outputs/desktop-review-2026-09-05/native-final-continuation.png)
