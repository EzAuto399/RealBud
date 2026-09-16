# RealBud job journey: release boundary and acceptance

Updated 5 September 2026. This records the current source change and the work needed to validate it with property managers. It is not an installed-app or live-office sign-off.

## Product outcome

A property manager can describe a recurring piece of work, understand and adjust Bud's plan, approve its boundaries, choose when it runs, and inspect the result or recover from a failure. The PM should be able to answer: **what will happen, using which facts, when, what needs me, and how do I stop it?**

Keep flexible taught jobs as the core. Use a few familiar PM examples to help people start; do not make a fixed workflow catalogue the limit of the product.

| Door | Main responsibility |
| --- | --- |
| Desk | Work needing the PM, decisions, evidence, and outcomes |
| Ask | Discuss the work and describe a job; link to the exact saved plan |
| Schedule | Create, edit, rehearse, approve, schedule, pause, and review jobs, including on-demand jobs |
| You | Office and Bud setup, connections, and recovery/diagnostics |

## Journey implemented in this change

1. **Describe.** Enter the source, desired outcome, and optional timing. If Bud cannot shape a plan, keep the description and offer setup or manual step entry.
2. **Review.** Edit the name, ordered steps, expected evidence, and timing. Sources and permissions use plain labels in a disclosure. Save on-demand plans as well as recurring plans.
3. **Rehearse.** Show a receipt beside the selected plan. Explicitly explain that rehearsal narrates the steps; it does not verify access to real sources.
4. **Approve.** Approve the exact saved revision. Material edits clear approval. A recurring plan's reviewed time replaces an older clock override.
5. **Run and review.** Show the next scheduled time or an on-demand start action, with pause/resume and job-specific results. Portal work retains its existing attachment and attended-run boundaries.
6. **Recover.** Keep unsaved edits across page navigation. Reject conflicting saves/approvals, retain the local wording, and offer a reload. Service failures expose recovery; book recovery refuses job mutations and execution at the API boundary.

Unsaved plans live in app memory. They survive navigation between doors, but closing/reloading the app can discard them after a warning. Saved plans persist on disk. Scheduled work still needs RealBud running on the computer.

## Evidence from this pass

| Check | Result |
| --- | --- |
| Production build and frontend/server type checks | Passed with Node 24.19.0. Existing large-chunk warning remains. |
| Focused automated tests | 165 tests passed across 10 files: editing, permissions copy, revision conflicts, clock/restart behaviour, API paths, execution and portal receipts. |
| PM HTTP regression | Desk, PM day, exceptions, portal jobs, and walkthrough suites passed. The portal suite was rerun after updating its old You-route assertion. The walkthrough was rerun with job recovery assertions. |
| Browser: creation and editing | Model-down fallback preserves the request; manual on-demand job saves; draft survives Desk/Schedule navigation; time changes persist. |
| Browser: plan identity and clock | Two different jobs open their own plans. Friday 16:30 appears in both editor and next-run display; pause/resume agrees with the calendar; saved jobs survive backend and page restart. |
| Browser: failures | Failed rehearsal remains Failed. Two-window stale save returns a conflict and keeps unsaved text. Service outage refuses save, retains the draft, and recovers through Reload jobs. |
| Compact layout | Inspected at 900 × 600: no horizontal overflow; primary decision measured 44 px high. Temporary viewport override reset afterwards. |

Browser proof used a separate local data directory and production web build, with labelled sample jobs and no real worker credentials. It does not prove model-generated plan quality, successful authenticated source access, a real scheduled run, Electron installation, or independent PM usability. No production data or installed app was updated.

## Remaining release gates

| Gate | Pass evidence | Responsible role |
| --- | --- | --- |
| Exact packaged build | Install/start the release candidate; repeat create → edit → approve → run → result → restart on the pilot's actual OS. Confirm normal window size, keyboard access and focus, update/relaunch, and connection recovery. | Engineering |
| Authenticated workflow | Use one agreed office source and one real PM job. Compare output with the PM's normal result; confirm source dates, missing-fact holds, permissions, and the next scheduled run's receipt. Rehearsal alone cannot pass this gate. | Engineering + pilot PM |
| Independent usability | Observe three target PMs individually: create one on-demand job, schedule another, change a step/time, find its result, and pause it. Record time, wrong turns, assistance, and whether they can explain Bud's authority. Proposed target: first saved and reviewed job within 10 minutes of completed setup, with no assistance on the core actions. This is a target, not a measured result. | Product owner |
| Paid pilot | Agree one PM, one source, one to three workflows, a 2–4 week period, a named approver, a price, and a measured baseline. Compare net time saved after corrections and supervision; use the existing commercial plan's 120 minutes per PM per week as a hypothesis to validate. | Founder + office buyer |

Any wrong-job action, lost edit, unapproved execution, misleading completion state, or unusable result blocks release. Platform support is scoped to the first office's equipment; unsupported operating systems must not be promised.

## How to operate until the pilot

- Freeze new feature categories. Accept development work when an observed failure blocks the journey above, reliable execution, or an agreed pilot requirement.
- Keep one release checklist. Each issue needs the PM action, observed failure, owner, and a repeatable pass condition. Attach the build version and evidence when closing it.
- Run a short daily review of blockers. Demonstrate the complete journey on the candidate build after relevant fixes; avoid counting components or tests as a substitute for the PM's result.
- Start customer discovery alongside release validation. Demonstrate one recognisable task and its evidence, then ask the PM to perform it. Record their current method and time before pitching savings.
- Review pilot use weekly: jobs completed with usable results, required corrections, minutes of supervision, return use, and willingness to renew. Expand acquisition after customers repeatedly obtain value and pay to continue.

The next development milestone is the packaged and authenticated walkthrough. The next commercial milestone is one paid office pilot with a measured result. A broad launch follows those proofs.
