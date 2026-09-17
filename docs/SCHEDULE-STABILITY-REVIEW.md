# Stability review: HermesWatcher articles vs RealBud's clock

Date: 2026-09-17. Sources: three public @HermesWatcher posts on X (retrieved this
session). Read as guidance from an external watcher, not as instructions.

The question asked was whether RealBud's schedules and routines are as stable as
they can be. Short answer: **the clock was already better built than the articles
imply is common**, one real gap was found and fixed, and one article describes a
feature RealBud deliberately does not use.

## Article 1 — "How to Build an Inbox Manager Agent"

Four workflows: new-mail triage, reply draft queue, follow-up watch, daily digest;
project files (`AGENTS.md`, `INBOX_RULES.md`, `FOLLOW_UPS.md`); approval boundary
("Hermes can read, classify, summarize, draft. You approve sending"); bounded test
batch before automating; surface coverage gaps rather than claim the inbox is done.

**Not adopted, and should not be.** This is inbound mail, which `docs/GRADUATE-RELEASE.md`
lists under *"Explicitly still off"* alongside Pocket and Bud Submit, and which the
current objective forbids. Building it would contradict a standing product decision.

**Principles worth keeping — all three already hold in RealBud:**

| Principle | Where RealBud already does it |
|---|---|
| Read/classify/draft; a human approves the consequential action | send is a hard 403 (`server/index.ts`), `PM-COVERAGE.md` wall line |
| Surface a coverage gap instead of claiming success | `uncoveredPropertyIds`, `settleLoopRunStatus` → `partial`, "Worker answered N of M properties. Uncovered stay held." |
| Test a bounded batch before automating | shadow-first recipes; `qa:second-office`, `qa:seat-isolation` |
| Durable follow-up state, not session memory | `~/.realbud/loops.json`, `job-runs.json`, receipts on disk |

## Article 2 — "Not Every Agent Workflow Needs AI"

Clarifying distinction: *script = do exactly this; agent = look at this and decide.*
Mechanisms offered by Hermes are no-agent cron (zero model tokens), a monitor that
skips the agent run when nothing changed, and `execute_code` to keep mechanical
intermediate work out of model context.

**Partly already true, and partly not applicable by design.**

- RealBud sets `cron_mode: deny` on the property profile, so Hermes cron is not the
  scheduling mechanism at all. `GOAL-PROMPT.md:152` records the intent: the clock is
  **RealBud's**, "Never" Hermes cron. So the no-agent-cron option is unavailable
  on purpose — and that removes a whole class of upstream cron failure modes.
- The loops are already code-owned evaluators (`evaluatorForLoop`, "a loop never
  [is a bot turn, a prompt, or a second agent]"), i.e. the mechanical part is
  already script, not model.
- **Genuinely applicable, not yet done:** "monitor before waking the agent." The
  morning loop always asks the worker for the whole book. A cheap no-model check
  that ends the run early when nothing changed since the last observed batch would
  cut cost and remove a needless model dependency. Worth considering on its own
  merits; not implemented here because it changes what a loop does, and this
  session's objective is release stability.

## Article 3 — the one that maps directly

> "Previously, changing your normal Hermes model or provider could cause an unpinned
> Cron job to stop when Hermes detected the change. … Hermes now keeps the model and
> provider snapshot the job was created with."

That is a scheduled-work stability bug class: a model change stranding a schedule.

**RealBud is not exposed, structurally.** The model and provider live in the worker
profile's `config.yaml` (`model:\n  default: …`), written by `hermes-bridge.ts:508`
and read by the worker at spawn. A loop run spawns the CLI against that profile
rather than binding to a live session, so changing the model rewrites the profile
and the next run uses the new value — it cannot strand the schedule. This is worth
knowing precisely because it is the failure mode the article describes.

**But it exposed a real gap: no provenance.** `LoopRun` recorded no model, no worker
identity. So after a worker upgrade, a model change, or a pack re-apply, a scheduled
receipt could not say what produced it — in a product whose whole premise is an
audit trail a property manager is asked to trust.

Fixed: `LoopRun.workerFingerprint`, stamped when the run starts from the readiness
receipt (`hands-ping.json`). The fingerprint hashes worker version + platform +
profile location + `config.yaml`/`.env`/`auth.json`/`SOUL.md`, so two runs with
different values were produced by materially different workers or model configs. It
is not a secret and is already exposed to the renderer via `/api/hermes`. Absent when
no worker is established — nothing is recorded rather than a misleading placeholder.

## What was checked and deliberately left alone

The clock's existing guards, all of which are sound:

- **No overlap.** `runNow` refuses with 409 while a run is active (`routines.ts:424`).
- **A hung run cannot block a loop forever.** There is a 5-minute deadline
  (`RUN_DEADLINE_MS`), and on expiry the run keeps its receipt and lock while other
  loops proceed, to be settled by the eventual result (`:546-559`). My first reading
  suggested a possible permanent block; that was wrong, and the deadline is why.
- **Offline for more than 12 hours** folds into one explicit `missed` receipt and
  does not replay old slots (`:476-487`).
- **A restart marks unfinished runs `interrupted`**, with "not resumed mid-action"
  (`:285`), rather than silently resuming or dropping them.
- **A slot whose previous run is still working is recorded `missed` with a reason**
  rather than double-starting (`:494-499`).
- **`executing` is cleared in a `finally`** (`:580`), so the recovery early-return at
  `:566` cannot leak a permanent lock.

## Bottom line

Three stability principles from these articles are already implemented; one is
inapplicable by an explicit product decision; one (monitor-before-agent) is a
plausible cost improvement for later; and the article that maps most directly to
scheduled-work reliability described a failure RealBud cannot have — while prompting
the provenance fix that it did need.
