# Ordered workspace setup sequence — 22 September 2026

This checkpoint replaces the unordered "Workspace setup" checklist on Desk and You with one ordered path whose every step reads a host fact. Its first form had seven steps; owner direction the same day reduced it to **three steps, one screen action each**. It establishes **source and local-test evidence only**. It does not exercise a packaged or installed app, Windows, a real Gmail account, a model, a worker run or a customer; it does not prove that any workflow can run, that a schedule fires, or that Bud's readiness check passes on a real machine (the harness deliberately leaves Bud unready). It adds no server route and changes no server, Electron, company, department or mail-ingestion code.

## The three steps

| Step | Title | Done when the host says | Action |
| --- | --- | --- | --- |
| 1 | Your agency | `GET /api/agency-setup` → `state.settings` holds an agency name (this form's, or the one saved on You), a `timeZone` **and** a `workflowPackId` | Open Agency workflow setup → Agency details |
| 2 | Connect your accounts | every account the selected work requires is verified — today only the private Gmail source, so the `gmail` check reading `passed`; the detail line is the host's own sentence for that check, rendered verbatim | Open Connections (`#you-connected-apps` on You); the account pick and check stay on the Schedule tab |
| 3 | Approve and schedule | the selected work's `mapping` check (bank work only) passes, every selected workflow is `readyForRun`, **and** its loop is available, enabled and carries a `nextRunAt` | Open Agency workflow setup, then Open Schedule once only the switch is left |

- `src/lib/setup-sequence.ts` is pure. `setupSequence({ officeAgencyName, agencySetup, schedule })` returns exactly three steps with `state: 'done' | 'current' | 'later' | 'unknown'`, a one-sentence `why`, a host-sourced `status` and one `actionLabel`. Exactly one step is `current`: the first whose host fact is not `done`. A step whose fact could not be read is `unknown`, never `done`. `readAgencySetupFacts` re-validates settings (now including `timeZone`), workflows and every check — including each check's `detail`, because step 2 renders the host's sentence rather than inventing one — and a malformed 200 reads as `unavailable`.
- **Naming the agency is no longer its own step.** The name saved on You and the name on the agency form each satisfy step 1, so the path never demands both. Step 1 is unfinished until all three of name, timezone and pack are saved, and it says exactly which of them is missing.
- **Bud is no longer a step.** The office can read and review this whole path before a worker is installed, so `budStatusLine()` renders one line under the card: "Bud: ready" or "Bud: needs setup on You" ("Bud: not checked yet" when unread).
- Step 2 is about the accounts the chosen workflows need, connected per seat through Connections. Today the only account any workflow requires is the private Gmail source, so it rolls up the host's `gmail` check across the selected work, or — before any work is ticked — across every workflow that reports one. A `bank-references`-only setup requires no account and reads done with "No connected account is needed for the work you chose." Its status is otherwise always the host's own check detail; this path states nothing about what has been collected from an account.
- Step 3 folds the former property-references, approval and schedule steps into one. Property references appear inside it only for `bank-references`, as the host's own `mapping` check detail.
- `WORKFLOW_LOOP_IDS` still maps only `morning-priorities` → `inbound-triage`, the one loop the host gates on agency setup and plan review (`server/routines.ts`). `bank-references` and `bills-calendar` have no loop of their own, so they stay visibly unreported rather than being mapped onto an unrelated book loop, and a setup that selects only those can never finish step 3.
- `src/components/desk/GoLiveCard.tsx` renders the path: title "Workspace setup", one `Step N of 3: …` block with the current step's reason, host status and **one** control, done steps collapsed into one line, later steps greyed, then the Bud status line. The inline agency-name field, the "Name it on You" control, the Bud control and the second bottom-of-card jump are gone. The bounded 15 s aborting `/api/agency-setup` read, compact mode, `pm-control` 44 px targets and accessible names are unchanged. `jurisdictions`, `office`, `onAttachWorker`, `attachWorkerLabel`, `onSaveAgency` and `onNameAgency` are still accepted from the Desk and You callers (`DeskPage.tsx`, `YouPage.tsx`) but no longer place a control; those two files are owned elsewhere and can drop the props.
- `src/components/schedule/AgencyWorkflowSetup.tsx` names its second tab "Connect your accounts" and numbers its tabs **1, 2, 3 and 3** — property references and Review workflows are two tabs of the one step 3 — and says so above them. `WorkflowPacksCard.tsx` says the same in its intro. No setup logic changed.

## Verification (source and local tests only)

| Check | Result |
| --- | --- |
| `pnpm exec vitest run src/` (Node 24.19.0) | 95 files, 868 passed, 0 failed, 0 skipped |
| `pnpm typecheck` (Node 24.19.0) | clean |
| `node scripts/qa-onboarding-setup.mjs` (rendered: real server from `server/bootstrap.ts` + real renderer through Vite, headless Chrome, Node 24.19.0) | 11 checks passed, 0 product defects, 0 renderer page errors; receipt `outputs/onboarding-setup-2026-09-22/receipt.json` (`passed: true`) |

The rendered run asserts, against a throwaway workspace: a fresh Desk reads "Step 1 of 3: Your agency" with exactly one `Step N of 3:` line, steps 2 and 3 unresolved, "Bud: needs setup on You" as a status line rather than a step, and nothing Done; that `PATCH /api/desk/agency` naming a fictional agency is accepted as the agency name (step 1 stops asking for it) while step 1 stays current for the timezone and pack; that one `PUT /api/agency-setup` saving name, timezone and pack together collapses step 1 into Done and advances the single current step to "Step 2 of 3: Connect your accounts", which stays not done with no account connected and renders the host's own check sentence verbatim; that step 2's single "Open Connections" action opens the You door with the `#you-connected-apps` section visible; and that the Schedule door opens with `#schedule-packs` scrolled into view and its tabs labelled `1.`, `2.`, `3.`, `3.`. The narrow-layout, book-timezone and first-run-replay checks are unchanged and still pass.

Screenshots (`desk-workspace-setup.png`, `desk-workspace-setup-named.png`, `you-connected-apps.png`, `schedule-packs.png`, `desk-390.png`, `you-office-timezone.png`, `onboarding-replay.png`) are fictional examples, never customer evidence.

## Limits and remaining gates

- No step past 2 was driven to `done` in the rendered run: no account can be connected in this harness, so step 3 is covered by unit tests with injected host facts, not by the browser.
- Step 3's loop fact is proven by unit tests with injected loop facts. No rendered run reached an enabled loop with a `nextRunAt`, because that needs a verified account, a reviewed workflow and a worker this harness does not have.
- Everything here is source and local-test evidence. It is not a packaged build, an installed device, a live Gmail read, a paid worker run or customer acceptance.

Reproduce:

```sh
pnpm exec vitest run src/
pnpm typecheck
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROME_EXECUTABLE="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node scripts/qa-onboarding-setup.mjs
```

Previous continuation: [docs/ONBOARDING-AND-SERVICE-RECOVERY-2026-09-22.md](ONBOARDING-AND-SERVICE-RECOVERY-2026-09-22.md). Agency setup contract: [docs/AGENCY-WORKFLOW-SETUP-2026-09-21.md](AGENCY-WORKFLOW-SETUP-2026-09-21.md).
