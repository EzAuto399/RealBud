# Onboarding end to end — 7 October 2026

The goal is that a new office goes from invite to staff doing real work with as few manual steps and dead ends as possible, on the website and in the RealBud app. This checkpoint follows two surveys: realbud.app at origin/main 4e54d0d, and the desktop at 4baf06b3 after PR #133. Each gap was then fixed where it lives.

**Evidence tier:** source and local tests. The renderer QA results are in the QA section below. Nothing is deployed, packaged or installed, and nothing has been through customer acceptance.

## The path now

| Step | Who | What happens |
|---|---|---|
| 1 | RealBud | Creates the invite on /admin (sent from our own mail client), and sees new pilot enquiries on the Desk. |
| 2 | Owner | Opens the invite, signs in, accepts the terms. The account, service and AI access are set up automatically. |
| 3 | RealBud | Sets the office's billing plan. If AI is billed to the office, the owner confirms the first month under AI usage & billing. The gateway then switches the office's AI pricing on by itself (`afterTermsAccepted` → `syncOfficeResalePolicy`). |
| 4 | RealBud | Uploads the office's signed role packs on /admin/offices → Workflow packs. |
| 5 | Owner | Installs RealBud, chooses "I'm the office owner: approve in my browser" and approves. For staff computers: Computers → Pair a new computer → **Copy message for staff** (download link, steps, code, expiry). |
| 6 | Staff | Installs, pastes the link code. The window appears straight away ("Getting your office ready"). Bud sets itself up behind a full-window "Setting up Bud" screen (usually about 10 minutes; if setup stops, it offers Try setup again or "Use RealBud without Bud for now"). Then they land on **Desk**, where Get started names the next step and offers their role pack. |
| 7 | Staff | When every step is done, Get started shows one dismissible line: "You're set up." |

## What changed

Website: [RealBud-website#26](https://github.com/EzAuto399/RealBud-website/pull/26). It is open, not merged, because merging deploys.

- **Owner dead end.** After setup, Computers sent the owner to "Your office isn't set up yet". `/signed-in` now offers one more sign-in, with the email filled in.
- **Terms stop.**
  - The invite page now says exactly how to finish and links to AI usage & billing. The old text, "RealBud has been told", was false.
  - The admin Desk and Offices pages name our next step: billing plan, then the owner's first month.
- **Copy matches the desktop.** Link code, Connect with this code, "I'm the office owner: approve in my browser". Staff are told to ask for a code once RealBud is open.
- **Link codes last 1 hour, not 10 minutes.** Migration `202610070001_pairing_code_lifetime.sql`.
  - A code stays single-use, bound to its office and owner-issued, with at most ten open at once.
  - Security review rejected 2 hours, because an unused code cannot be cancelled.
  - The copy never states the lifetime. The panel shows the real expiry time.
- **Operator pack upload.** Owner decision, 6 Oct: RealBud uploads each office's role packs. The shared `savePack` applies the same checks as the owner route, and only active offices are accepted.
- **Other.**
  - Customer-facing name is "Auston"; the FAQ lists Windows.
  - Sign-up copy is for the owner and tells staff they need no account.
  - Windows download fallback.

Desktop: branch `claude/onboarding-polish`.

- **The window opens before the office service starts.**
  - The old first window took 98.5 s on the Windows VM.
  - `electron/launch-window.mjs` keeps a single start-or-adopt. The outcome replaces the waiting page in the same window.
  - The waiting and timeout pages no longer mention log files, the database or keys.
- **Linking lands on Desk.** Bud setup opens over Desk. The sample desk no longer saves "Sample PM" as the person's name.
- **Get started.** It shows a "You're set up" line when every step is done, and a timed-out read retries after 3, 10 and 30 s (Windows #15).
- **Bud setup holds.**
  - **Restart RealBud's service:** the service outlives the window, so "Quit and reopen" never restarted it.
  - **Save a support file** for a damaged setup record.
  - Plain step names.
  - An install interrupted by an update resumes once on the next service start (Windows #28), counted within the five-attempt limit.
- **Packs.** The built-in Kevin and Sherry role packs show in the staff path when the office has shared none. Owner tools stay in the owner section.
- **Copy.** Office-link errors and restart advice now say what to do.

## Checks

- Website: `npm test` 417 pass, 0 fail, 2 skipped (the baseline skips); `tsc` clean.
- Desktop: `pnpm typecheck` clean. 692 focused tests pass, 16 Windows-only skips.
  - Electron: 386 tests.
  - Onboarding, Get started, setup holds, packs, office link and setup sequence.
  - New tests fail without their fixes.
- Renderer QA (headless Chrome, fictional data, built UI; receipts in `outputs/onboarding-e2e-2026-10-07/`): see QA below.

## Not done, and why

- **`realbud://` deep link.** Not done. "Copy message for staff" covers the code hand-off without a protocol handler.
- **`/api/austin-pack/install`.** Kept, because `scripts/qa-austin-pack.mjs` still calls it. Its README line is stale.
- **Invite page after the owner accepts terms.** It still needs one "Try again" to show Ready. AI already works by then.
- **Per-person pack targeting.** Not done: each person picks their own role pack.
- **`startCuaControl()`.** Still awaited before the window. Not measured.

## Owner actions

1. Apply `202610070001_pairing_code_lifetime.sql` to production Supabase, then merge website #26. Either order is safe.
2. Sign the Kevin and Sherry role packs, then upload them on /admin/offices → Workflow packs.
3. Code signing (Windows SmartScreen, Mac notarisation). Unchanged.

## QA

All runs use the branch's own built UI, a fresh temp home and fictional data. No `~/.realbud`, live account or model was used.

| Script | Result |
|---|---|
| `qa-clean-walkthrough` | **13/13 steps pass.** Covers: welcome; link code through the lab website; Bud status opening over Desk; Desk; Work; Schedule; approval and Stop; service down and recovery; Settings; restart; update banner; expired then fresh link code; no page errors. The first run failed step 3 because it still expected Work after setup, so the script was updated to expect Desk. |
| `qa-first-install` | Pass (9 checks). Setup opens over Desk; install progress, cancel and retry work; the Work draft is kept. |
| `qa-onboarding-setup` | Pass. Get started shows the five steps and their links. |
| `qa-onboarding-restart` | Pass (all PASS lines). Interrupted welcome, sample exploration and a restored book all survive restarts on changed ports. |
| `qa-bud-status` | Pass (9 checks, 18 screenshots). |
| `qa-customer-packs` | **Fails at line 121, as it already does on main.** The script expects `workflowPackId` to stay null after a pack import. #133 changed import so that it selects the agency workflow. This was reported to the session that owns #133, and its fixture expectation was left unchanged. |

Screenshots: `desk-get-started-after-link.png` shows the person landing on Desk with Get started at 2 of 5 and "Import your office's pack · Now". `bud-status-over-desk.png` shows Bud status over Desk.

Not run:
- the packaged build
- Windows VM time to first window (98.5 s before this change)
- macOS Dock-during-wait on a real app
- website `next build` and its Postgres suites
- `qa-hermes-updates`, which is already stale on main: it waits for labels that no longer exist in `src/`
