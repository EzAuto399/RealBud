# Own-bank Mac QA — 23 September 2026

Scope: one owner-operated bank export to a local CSV, plus a small synthetic
Modelvia request through RealBud. No REI upload. Email workflows and department
joining are subsequent runs. This is supervised QA, not general release acceptance.

The owner selected **Commonwealth Bank Australia** for this run. Use one account
and a seven-day sample selected by the owner. Auston's ANZ screens/export format
still require a separate acceptance run.

## Current result

The fresh 0.1.19 package built successfully from `fb6cebed` plus the local storage
fixes; the source digest stayed unchanged during packaging. Strict deep signature
verification and packaged renderer/capabilities/server/shutdown smoke passed.
The isolated app was launched normally at `127.0.0.1:28799`, first-run onboarding
was completed as **Own-bank QA**, and **Office → Website account** is open with
computer name **Own-bank Mac QA**. It is not linked yet.

The first normal setup reported **Bud update blocked**, because an empty QA
installation fell back to the global, unsupported 0.21.4 worker. Its administrator
was also unprovisioned; website linking does not provision that administrator.
For this directed QA only, the launcher now selects the already installed 0.21.3
runtime, whose clean Git checkout matches the admitted `345cd2b0` commit. The QA
data/profile stays separate. The identity-checked QA service was stopped and
restarted; its API now confirms compatible=true and its UI says **Model needed**.
In-app runtime updates are unavailable while this explicit runtime selection is
used. This is a QA workaround, not proof of complete fresh-machine setup.

The QA service moved from port 28799 to 8799 after restart; onboarding reappeared
with the saved name and was completed again. Record this as an unresolved restart
usability finding, not a passed onboarding-persistence test. No bank account was
accessed and no fresh inference request was made.

## Start

Open `launch-qa.command` in this directory after the package smoke passes.
It uses a separate QA data directory and Electron profile under
`~/Library/Application Support/RealBud QA/own-bank-2026-09-23`.
The installed `/Applications/RealBud.app` and its records are unchanged.
Keep bank CSVs in private local storage, not this source/evidence directory.

## First run (15–20 minutes after account/model setup)

1. In **You → This office → Website account**, name the computer **Own-bank Mac QA**
   and choose **Link with your RealBud account**. Complete sign-in yourself and
   check that the displayed codes match. Refresh **Update status**. Model access
   must actually provision; an account link alone is not a pass.
2. Complete **You → Bud setup** and **Run readiness check**. Send a synthetic
   message: `Reply exactly: QA model connection OK.` Pass only when the actual
   model response and one settled usage receipt agree. Do not send bank rows as
   the service-connectivity test. No automatic retry after an unknown outcome.
3. In **You → Connections → Browser**, connect the intended Chrome/Edge profile,
   check the connection, and select **Use this browser**. Sign into your bank
   yourself. Select one account and a short, explicit date range.
4. In Ask: `Download the transactions CSV for [date range] from my already
   signed-in bank tab at [exact hostname], for the account I select. Stop after
   the CSV is saved.` Review the task card and start it. Check the downloaded
   file's date range, row count, amounts and encoding against the bank. No payment
   or transfer is part of this task.
5. Confirm Stop works and reopen RealBud to check that the task and saved result
   survive. Record pass/failure, elapsed time and the visible error only. Do not
   copy account numbers, transaction rows, passwords or MFA into the QA receipt.

## Known gates

- At 12:03 Brisbane, deployed Modelvia revision `a8938b16` answered authenticated
  status and project reads. Its two model routes were approved, but all five
  projects were inactive. A usable QA project/key or successful normal RealBud
  provisioning is required before a fresh inference call. No project, key,
  approval, budget or billing configuration was changed by this run.
- Browser downloads currently return a private-task receipt. Source inspection
  found no visible file-open/export control or direct handoff into Bank CSV
  review. Treat inability to retrieve the saved CSV as a failed end-to-end test.
  A manual bank export can separately test the downstream CSV review screen.
- **Schedule → Prepare bank references → Prepare a new export** is the current
  reference-review tool. It expects a signed amount column and an actual reference
  mapping; do not invent property matches for personal transactions. Its output
  still says **Download reviewed REI copy**, but this run stops at the local CSV.

## Evidence

- `build-input.json`: source revision and digest before packaging.
- `package.log`: fresh package build, including the local storage fixes.
- `modelvia-preflight.json`: live public health/readiness/auth-denial checks.
- `modelvia-auth-preflight.json`: live read-only route/project readiness.
- `worker-preflight.json` and `worker-after-selection.json`: before/after worker
  admission; model readiness remains false until a real model check passes.
- No bank or fresh model-inference acceptance is claimed by these preflight files.
