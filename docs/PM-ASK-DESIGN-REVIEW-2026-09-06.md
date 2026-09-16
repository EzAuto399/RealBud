# Ask workspace review — 6 September 2026

This pass improves the Ask screenshot supplied by the user: several repeated warnings competed with a dense answer, while the small composer and separate follow-up button made the next step unclear. The work retains the four-door RealBud structure and the independently managed Hermes worker.

## Changes

| Area | Result |
| --- | --- |
| Workspace | Lighter paper, clearer ink/dividers, consistent spacing and navigation hierarchy. The header identifies Ask Bud and the current work state. |
| Book context | A keyboard-accessible disclosure shows sample/office scope and the last recorded Desk check. Historical failures remain visible there. Worker readiness does not upgrade book facts. |
| Answers | Stable author and timestamp, a readable response surface, clearer tables with keyboard scrolling, visible Copy and Make this repeatable actions. Copy only reports success after clipboard acceptance and provides a failure message. Long requests expand without losing their original text. |
| Composer | A larger persistent draft area, labelled attachment control, visible Start work action, and contextual keyboard guidance. Existing send acceptance, approvals, steer, queue and cancellation behaviour is retained. |
| Setup | The private connection check runs inside Ask. Ask and You share one in-flight request, including across navigation. The full server status remains authoritative; a successful ping never auto-submits a draft. Failure offers retry and settings. |
| Recovery | Once Bud is connected, an old failed book check offers a fresh book check rather than repeatedly redirecting to model setup. |
| Space | Sidebar guidance becomes a compact upcoming-work summary on Ask. Secondary book/job actions collapse; active plan/attended-work actions remain expanded. The composer and conversation have separate scrolling. |
| Build | Tailwind discovery is limited to the UI source directory so QA artifacts and copied packages cannot add unused utility rules. |

No approval or permission boundary was relaxed, no persistence schema changed, and no new dependency was added. The request and response carried into a job remain reference material; creating a reusable draft does not approve or run it.

## Verified in source and browser

All data in the walkthrough is fictional and uses a separate directory under `outputs/ask-design-2026-09-06/`. The user's ordinary app data and property facts were not used for the browser tests.

- Full suite: **1,005 passed, 8 skipped, 130 files passed**. Focused checks cover readiness prerequisites, concurrent requests, view subscriptions, synchronous/asynchronous failure, retry, draft preservation, work continuation and next-action routing.
- Production build and frontend/server TypeScript checks pass. The existing large-JavaScript-chunk warning remains.
- Real model readiness passes inside Ask. Switching to You while it runs shows the same disabled Checking action; returning to Ask retains the draft and the authoritative ready state.
- A blocked Ask submission retains the whole request. Restoring connectivity and reloading preserves it; explicit retry produces a real six-property training-book review.
- A controlled HTTP 503 from the readiness endpoint shows an actionable error, Try check again and Bud settings. Removing interception and retrying passes the real readiness check; the unsent request remains intact.
- Copy response reports success after acceptance. Make this repeatable opens the editable job description with the original request and bounded response excerpt, without starting the plan.
- Desktop layouts at **1440 × 920** and **900 × 600** were inspected. The compact view has no horizontal document overflow and keeps the input and action controls within the viewport. Context can be opened and dismissed with Escape; keyboard focus remains visible. Reduced-motion inspection reports no answer animation.
- The first walkthrough exposed a welcome-screen scroll issue; empty conversations now start at the top. Long answers retain their author header while scrolling, and Jump to latest no longer covers the composer.

Evidence: [review folder](../outputs/ask-design-2026-09-06/). Browser failure interception is removed after each test. Screenshot observations represent actual rendered UI, not mockups.

## Limits

The real model tests use labelled training properties. They do not prove live PMS/inbox/portal access, every Hermes capability, customer time savings or an independent PM usability study. Consequential work still requires the existing human controls. This pass does not publish a release or establish Apple notarization.

## Packaged and installed proof

- Built the final **0.1.17 arm64** app with Electron **43.4.0**, including both TypeScript checks and the native helpers. Developer ID signing and strict deep signature verification pass. CDHash: `a211741677fb5723ea15eaa444122047c6a670bb`.
- Package smoke passes renderer/preload capabilities, embedded-server startup and shutdown.
- The real Hermes canary runs under this exact bundle's Electron executable and imports production modules from that bundle. It passes provider readiness, plan drafting, rehearsal, revision-bound approval, computed receipts, duplicate prevention, persisted receipt reload, real quote-file reading, the unpredictable source reference, AUD 110 arithmetic, complete **2,513-character** output, a follow-up and fresh-process transcript recovery.
- The native walkthrough opens a copy of this review's fictional book with a separate app profile. A real concise follow-up preserves all six table rows and the sample-data boundary. Working/ready status, draft acceptance and follow-up actions are visible in the final packaged UI.
- Installed **`/Applications/RealBud.app`** after verifying there were no active bot, job or routine runs. All **767 file/symlink entries** match the tested package, including contents, file permissions and link targets. The installed path independently passes package smoke.
- The previous app is retained at `outputs/ask-design-2026-09-06/rollback/RealBud.app`. Staging and identity verification completed before replacement. The first staging check encountered the system Python's missing `hashlib.file_digest`; the original app remained untouched, and the retry used a compatible bounded hashing implementation.
- Reopened the user's existing book and conversation in the updated app. Historical Desk facts and transcripts remain intact; no live book recheck or message was submitted from that conversation.
- The installed app's new in-place connection check passes and the header reads **Bud ready**. The existing 4 September Desk check remains historical. `installed-status.json` records these distinct states.
- The final scoped diff check passes. A wider check also found a pre-existing blank line at EOF in `src/lib/telegram-channel.test.ts`; that unrelated file was left unchanged by this pass.
- Browser viewport, reduced-motion overrides and network interception were cleared. The source preview servers and isolated native app were stopped. No release was published; notarization was explicitly skipped by the package configuration.

![Final packaged Ask with a real training-book follow-up](../outputs/ask-design-2026-09-06/native-final-ask.png)
