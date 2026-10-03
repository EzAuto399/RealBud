# Job setup and browser friction — 1 October 2026

The screenshots came from the fictional source preview on port 57499, not the installed service on 8799. Its connector implements only fictional Gmail reads. App authorization falls through to HTTP 404 with an empty object; its fetch guard blocks native browser discovery and reports `QA denied non-connector fetch`. Its deterministic invoice worker cannot return memory-proposal or general job-plan results. These failures do not establish that the user's Google credentials or installed browser are broken. A read-only check of the installed browser reported ready, enabled and inactive.

## Changes

- An explicit `design-preview` build carries a visible banner, labels setup sheets, and disables live Ask, sign-in, browser, job approval and execution controls. Search, descriptions and examples remain inspectable. The interactive fixture launcher refuses an unlabelled renderer. Preview memory panels no longer report a fictional worker as an outdated live worker.
- Connection errors use fixed, typed messages. A known pre-link refusal explains that sign-in never started. Unknown outcomes ask for a status check without inventing an open sign-in window or automatically creating another link. A returned link is described as ready; requesting that a browser open it is not reported as confirmed opening.
- Teach Bud a job starts with one description and three examples. A saved suggestion shows its source and timing, with exact steps/results and editable fields available in disclosures. One explicit **Approve and try once** action approves the exact unchanged on-demand revision and starts preparation. Existing request IDs preserve lost-response recovery. Browser jobs retain their site/account review path. A first suggestion cannot silently activate the cadence mentioned in the user's description; repeat timing follows a result and still needs an explicit schedule decision.
- Work browser shows its current status and one next action; recovery, account help and connection details are grouped below. Preview and offline states cannot appear ready. Failure to stop does not claim the user has taken over.
- Eligible bounded Ask tasks reuse their task permission for native read-only actions. Host proof binds the live grant, request, run, selected browser, tab and origin; rules, expiry, limits, fresh observation, account checks and stop/revocation remain enforced. This is not a standing site rule. Unknown controls, consequential actions, transfers and legacy jobs keep their prior controls. The broker rechecks authorization after asynchronous observations and immediately before dispatch.
- Schedule section links align the requested section at the top. Leaving a You section correctly updates the page URL, so refreshing Schedule does not return to You.

## Computer use still to close

Ask currently mounts the owned native browser, not the legacy whole-computer fallback. It does not attach personal-browser tabs or copy their cookies. Native upload/download, scoped app/window controls, screenshot-based fallback and bank-to-REI outcome verification remain separate implementation and acceptance work. A retained profile may reuse valid sessions; websites still control expiry and MFA.

The next computer-use slice should let a user select a work app/window once for a bounded task, verify the selected surface and account, then reuse that authority for ordinary reading/navigation. It must preserve Stop/takeover and require a fresh decision when destination, account or consequential effect changes. Do not label that capability ready before exercising the actual product route.

Validation and packaging evidence is stored in `outputs/workflow-ux-2026-10-01`. Fictional renderer checks are not live workflow acceptance; deployment status is recorded separately from source tests.
