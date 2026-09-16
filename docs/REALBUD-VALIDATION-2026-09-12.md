**RealBud validation and Kevin workflow rehearsal — 12 September 2026**

Milestone 1 is **partially demonstrated and incomplete at the guarded existing-browser read**. The installed RealBud now answers through its own connected model. Broad automated checks, UI rehearsals and synthetic tasks with the real model passed after the repairs below. Neither those results nor the enabled macOS switches prove working, bounded computer control.

Evidence is saved in [the validation folder](/Users/yoda/projects/PropertyMe/outputs/realbud-validation-2026-09-12/README.md). No customer accounts, real bank/REI operations, messages, customer schedules, commits or deployment were performed. This report tests existing foundations; it does not change RealBud into a portfolio/PMS or start the later roadmap milestones.

**What is running and what was demonstrated**

Checkout: `/Users/yoda/projects/PropertyMe`, branch `main`, HEAD `058aceabe04aed77c285f2f52f7803fc19bc7ee9`. There were **425 pre-existing dirty status entries**. The before-record contains 679 source hashes; the final comparison found no other changes among those recorded source files outside this task's manifest. Pre-existing modified and untracked work was preserved.

The installed application is `/Applications/RealBud.app`, version 0.1.18, serving bundled `Contents/Resources/server/index.js` and `Contents/Resources/ui` on port 8799. The initial server PID was 48386; after controlled recovery/relaunch, the final observed PID was 11902. The installed bundle differs from the working source and was not patched or replaced by this validation. Initial artifact identities:

| Artifact | SHA-256 |
|---|---|
| `app.asar` | `9a7a74646f96a8d151f95feef2a152852bf89e74f3016c1893d485c87b52d522` |
| `server/index.js` | `1dc07f6ddd1f23edcbfa23cda235ce075d3b701247bd318ad3c3cd5335767964` |
| `ui/index.html` | `6c4a3b9b1f51225c7387f5eed7d4d88bd92620da79f9a2a31783779f794b391a` |

The observed initial model failure was missing selection/usable provider connection in RealBud's own profile, not evidence that a supplied credential was invalid. The owner completed **Connect a model** in RealBud. Final `/api/hermes` reports ready, provider `deepseek`, model `deepseek-v4-flash`. Worker state resolves to `/Users/yoda/.realbud/hermes/profiles/property`; executable resolution uses the independently installed `hermes` CLI, found at `/Users/yoda/.local/bin/hermes`, with engine code under `.hermes/hermes-agent`. Using shared executable code is distinct from using personal profile data. Relevant launch hardening and owned-home tests passed; no personal histories, cron jobs, cookie jars or credentials were imported. Actual engine version was 0.20.3 (2026.8.16.2); the source retains its explicit 0.21.0 compatibility entry. Cua remains pinned to 0.19.3. No dependency upgrade was made.

An actual native-UI Ask, marked `QA-20260912-MODEL`, returned **17 × 23 = 391**. Correlation: Bud `bud`, task `a0393238-fa65-42c9-8f0e-8137f5db7627`, run `57333630-74e3-4f7f-82c7-15e32850c18c`, provider instance `hermes`. The saved worker events and answer distinguish this from an echo or fixture.

An actual Stop on a longer fictional reply returned “Stopped. Bud will not continue this turn.” Run `ccc3df05-4305-4e29-991b-cbdf49ae6c18` ended with `stopReason: cancelled`; the adapter's `ok: true` field is **not** treated as successful task completion. The stopped result survived restart. This demonstrates local UI/adapter cancellation and durable state, not confirmed cessation of remote provider inference. Source cancellation tests separately prove termination of an owned preparation process; scripted stale-approval and restart cases pass.

The source runtime also passed live-provider plan shaping, rehearsal, exact approval, computation (17 + 26 = 43), duplicate prevention, receipt reload, actual synthetic-file reading and quote arithmetic, warm ACP continuation, and fresh-process transcript recovery. These are source-runtime proofs and do not establish that the installed app contains the new repairs.

**Repairs and review findings**

1. **Desktop shutdown:** the old `before-quit` handler stopped the server before windows could accept or cancel closing. That can strand a window with a dead service. Cleanup now starts at `will-quit`, runs once, handles a failed helper, and has a bounded deadline. Unit tests and a real Electron rehearsal prove that cancelling close preserves services and that a hung helper cannot indefinitely prevent final quit. The installed quit failure was observed and recovered by terminating only the identified idle RealBud main process; the exact event sequence in that old running bundle was not instrumented. The repair is source-only.
2. **Bounded-adapter lease:** same-category work could replace an existing lease and a stale category release could release a newer acquisition. Leases now bind an immutable acquisition ID, work item and revision. Overlapping and expired-but-unreleased ownership cannot be replaced; stale releases and stale action checks fail. Portal calls have a 30-second fetch bound. The Cua pin comparison now rejects `0.19.30` instead of accepting it as `0.19.3`. This lease protects the existing in-process bounded portal adapter; it is **not** a device-wide or cross-process lock for the live ACP computer path.
3. **Ask recovery controls:** phone and Schedule dialogs now attach keyboard handling when opened, including Escape, focus restoration and IME handling. The Add panel stays inside the viewport so Refresh remains reachable after mobile scrolling. Built-UI tests reproduce and verify these repairs.
4. **Model output:** Bud's prompt now separates bill arrival timing, coverage, due-date knowledge, receipt, arrangement, funding and confirmed payment. It also withholds tenant acknowledgements/reminders when a payment or recipient remains unmatched. These correct demonstrated reasoning failures, not the durable expected-bills data model. They are guidance, not an execution-security boundary.
5. **Plan shaping:** the prompt now states the already-enforced field limits. Invalid cards return a safe, actionable field constraint instead of an opaque error. A focused test proves raw worker content is not returned in that validation error. An initial live draft was unusable; a later probe was valid. The original model output's exact defect was not captured, so it is not attributed conclusively to length. The full live contract passed after the change; model reliability is not guaranteed by one passing run.
6. **Test maintenance:** repaired the Telegram test's TypeScript narrowing error and updated stale Discord copy, Platform-key/header fixtures, routes and dialog selectors to current production contracts. Removed a vacuous UI assertion. Production credentials and connector permissions were not changed to make fixtures pass.

The exact 23-file change list, before/after hashes and original status are in [change-manifest.json](/Users/yoda/projects/PropertyMe/outputs/realbud-validation-2026-09-12/change-manifest.json); the intended diff is [changes.patch](/Users/yoda/projects/PropertyMe/outputs/realbud-validation-2026-09-12/changes.patch). It includes three new files: `electron/shutdown.mjs`, its test, and `server/computer-lease.test.ts`. All other edited files were already present. The final intended diff was reviewed, with no added trailing whitespace. A whole-checkout whitespace check also reports a pre-existing trailing blank line in `src/lib/telegram-channel.test.ts`; it was left untouched.

**Testing performed**

All commands below ran with Node 24.3.0 using `fnm exec --using=24`; the default shell Node was older than the project's required version. Logs preserve original failures as well as successful reruns.

| Check | Result and limit | Evidence file in validation folder |
|---|---|---|
| `pnpm test:coverage` | 188 files passed; **1,927 passed, 8 skipped**. Server coverage: statements 79.04%, branches 70.31%, functions 84.11%, lines 83.55%. Coverage configuration excludes the main service entry point and certain subprocess modules; this is not whole-app coverage. | `coverage.log` |
| Final relevant unit checks | 28 passed across lease, bounded Cua, portal handoff, plan shaping and shutdown; 15 Ask tests passed after the final prompt repair. One new validation-error test was added after the full coverage run. | `final-focused.log`, `ask-final.log` |
| Build and typecheck | Passed frontend build, server typechecking and server emission; existing large-bundle warning remains. | `build-verified.log`, `typecheck-verified.log`, `server-build-verified.log` |
| `pnpm qa:e2e` | All five suites passed, including final rerun after lease changes: Desk, PM day, exceptions, portal jobs and walkthrough. | `e2e-verified.log` |
| `pnpm qa:kevin-day` | **32/32** fixture checks passed. | `kevin-day.log`, `kevin-day-receipt.json` |
| `pnpm qa:workflow-packs` | Install, approve, retune, export/import, bill states and denial/recovery simulations passed. | `workflow-packs.log`, `workflow-packs-export.json` |
| Built Austin UI | **15 checks passed**: real UI/API, synthetic ACP/Cua, exact/replayed/concurrent decisions, stale Stop/restart, login checkpoint and selected-step recovery, bank reference-only review/download preserving source. | `austin-browser/result.json` |
| First install UI | **9 checks passed**, including retry, interrupted setup and mobile sizes. | `first-install/result.json` |
| Workspace UI | **21 checks passed**, including navigation, persistent drafts, failed/partial requests and mobile layouts. | `workspace-ui/result.json` |
| Phone/Telegram UI | **11 checks passed** using simulated transport. No live Telegram delivery. | `telegram-ui/result.json` |
| Desk continuity UI | **9 checks passed**, including draft preservation, synthetic OAuth return, Refresh failure/recovery and panel bounds. 48 stub-provider requests, one synthetic sign-in, zero mailbox operations. | `desk-continuity/result.json` |
| Electron lifecycle | Real Electron rehearsal passed cancelled-close preservation, cleanup exactly once and a 200 ms test deadline for a hung helper. | `electron-shutdown-receipt.json` |
| Release-script unit tests | 6 passed; not a new signed/installed release. | `mac-release.log` |
| Real Hermes contract | Provider ping, plan execution/receipts, synthetic file task, ACP continuity and restart passed. | `live-hermes-contract-rechecked.log` |
| Real-model PM cases | **9 final reviewed scenarios passed**, combining initial cases and targeted reruns, with the quality limits below. | `pm-simulation-reviewed.json` |
| `pnpm qa:scale` | 150/300/600-record fixture completed. At 600: Desk 29 ms, CSV preview 478 ms, import 489 ms, snapshot 518 KB. One local timing sample, not saved staff time or an argument to expand the portfolio. | `scale.log` |

An initial Node test-runner invocation on Vitest files was a harness error; those files subsequently passed through Vitest. Initial unit/build failures and UI-selector/oracle failures are retained in the earlier logs, not relabelled as successful runs. The eight skipped tests remain outside the demonstrated coverage; Windows-specific execution remains unverified here.

**Kevin and PM workflow review**

The fixture day covers opening Desk, the two Austin workflow packs, reviewer-approved plans, connection state, expected-bill exceptions, morning Ask, approval/denial, password/Pay fences, blocked uncalibrated Continue, recheck and export. Some negative cases intentionally finish `partial` or `failed`: that is a successful denial test, not completed office work. Its Calendar check only establishes a reply; it does not prove calendar sync. Its bank chapter does not itself import a real bank CSV; the separate Austin UI test verifies a synthetic reference-only output byte-for-byte.

The real-model tasks were bills coverage and independent payment states; a morning plan preserving fixed appointments and travel; incomplete quote comparison; maintenance intake; conflicting arrears evidence; inspection preparation; an instruction injected into a supplier document; corrected instructions; and handover after worker restart. Each file case used an unpredictable training reference to prove source reading. Saved answers were manually reviewed in addition to automated checks.

The first installed bills response wrongly used an unknown payment due date to deny that the arrival window had passed. The corrected source response preserves both the passed window and incomplete search. Initial source-test false failures on “Funding sufficient: No” and explicit travel intervals were checked against saved answers before adjusting the regexes. A separate manual review caught a more serious arrears answer that thanked the tenant for an unmatched payment despite otherwise passing checks. The new rule and focused rerun retain both dated observations and withhold the tenant draft.

Some responses remain longer than necessary and add unnecessary statutory disclaimers to unrelated drafts. These scenarios demonstrate useful supervised preparation, not universally reliable judgement. No generated draft was sent, no ledger was changed and no payment was made. Kevin's roughly every-two-days cadence is still not a confirmed daily or Monday/Wednesday/Friday schedule.

**Outstanding acceptance gates**

| Capability | Configured | Callable | Guarded | Tested | Packaged | Installed | Austin verified | Commercially accepted |
|---|---|---|---|---|---|---|---|---|
| Harmless Ask through owned model | Yes | Yes, native UI | No-tool request observed; general tool containment incomplete | Live installed call + source tests | Existing 0.1.18 | Yes, existing bundle | Not verified | Not verified |
| Stop and restart continuity | Yes | Yes | Local cancellation/stale-event tests; remote inference cessation unknown | Installed Stop/recovery + source tests | New shutdown fix not packaged | Fix not installed | Not verified | Not verified |
| Selected existing-browser read | Descriptor unavailable | **No** | **Incomplete** | Negative fixtures only; no live read | Existing helper present, bundle signature invalid | Present but unavailable | Not verified | Not verified |
| Bounded portal lease/handoff | Fixture/source bindings | Synthetic path | Local revision checks pass; live cross-process ownership incomplete | Unit/e2e/scripted UI | New lease fix not packaged | Fix not installed | Not verified | Not verified |
| Reviewed bank-reference copy | Synthetic mapping only | Yes in local rehearsal | Reviewed output/unchanged source checks pass for supported fixture format | Source + built UI | Not assessed for current revision | Current revision not verified | REI schema/import not verified | Not verified |
| Expected bills and PM preparation | Synthetic cases; real model | Yes for preparation | Prompt distinctions and human review; durable state gaps remain | Fixture + real-model cases | Prompt repairs not packaged | Repairs not installed | Not verified | Not verified |
| Gmail/Calendar and Telegram | Stub configuration tested | Synthetic transport only | Contract/approval tests only | Local tests/UI | Current revision not assessed | Live delivery/sync not tested | Not verified | Not verified |
| Windows/native operation, voice, updater delivery | Not assessed here | Not verified here | Not verified here | Related unit tests only where present | No fresh package acceptance | Not tested on target hardware | Not verified | Not verified |

Two blockers prevent the Milestone 1 browser acceptance:

- **Installed app/permission mismatch, now confirmed by macOS logs:** both RealBud switches are ON in System Settings. The follow-up diagnosis found TCC's explicit rejection for PID 11899 at 20:39:28: “Failed to match existing code requirement” for both Accessibility and ScreenCapture. The saved grants require bundle `com.realbud.app` signed by Developer ID team `4F4SMS88P8`; the running copy instead has an ad-hoc signature with no team. Separately, `codesign --verify --deep --strict /Applications/RealBud.app` fails because installed resources were edited after signing. This is an identity mismatch, not a missing switch or merely a hypothesised cache problem. The bundled SDK's synchronous permission status shape matches the source's checks. See `permission-root-cause.json`, `tcc-realbud.log`, and `installed-final-state.json`. A correctly signed replacement must be verified before installation; toggling permissions on this altered copy does not restore the original signing identity.
- **Execution boundary, source-confirmed:** product Ask mounts the raw local-computer descriptor in `server/index.ts`; `server/drivers/acp/core.ts` forwards it to ACP, while `server/local-computer.ts` discards bounded-session metadata. The installed Hermes ACP session enables `hermes-acp`, which includes terminal/code, file, web and browser routes. The repaired portal lease is not on that actual raw ACP path. A permission prompt or prompt instruction does not prove those alternatives are contained. No live outside-origin or stale-revision execution denial was demonstrated through a complete guarded browser route.

The selected benign tab/session still needs an explicit identity for the final proof; the owner's “done” confirmed permission work but did not name a tab. No other tabs, customer data or banking were inspected as a substitute. Do not solve this by copying cookies, starting a new profile, switching vendors or enabling an unrestricted controller.

A later-slice review concern remains in the expected-bills loader: unreadable/corrupt saved state can be returned as an empty register, and one flat status cannot fully represent independent arrival/coverage/payment facts. This was identified, not implemented, because the supplied contract defers that state-model work. The Ask prompt repair does not resolve it.

**Recovery and next concrete work**

The source changes use no persisted-schema migration. Before-images and the exact patch allow selective rollback of only this task's hunks; check current hashes and subsequent edits before restoring anything. Do not reset the working tree or restore old writable databases. The installed app and owner-entered model connection were preserved. Do not activate computer jobs while the guarded path remains unproven.

The next engineering slice is to preserve the working model connection, resolve the installed package/permission identity with a reproducible intact artifact, and make the chosen worker's computer/file/network capabilities pass through an enforceable broker with real device/run/revision ownership. Then, with the owner-selected existing benign tab, prove one read and execution-boundary rejections for the wrong origin/action and stale revision. Repeat Stop/restart on that installed artifact. No customer onboarding, REI posting or routines should be inferred from the current tests.

This completes the available local validation and documents the blockers; **Milestone 1 and full product acceptance remain incomplete**. Packaging/deployment and customer-facing activity remain outside this invocation's authorisation.

Follow-up to the owner's permission report: [the correctly signed repair was installed after the owner authorised it](/Users/yoda/projects/PropertyMe/docs/REALBUD-PERMISSION-REPAIR-2026-09-12.md). macOS now grants Accessibility and ScreenCapture, the installed embedded helper starts, and native Ask returned 37 + 8 = 45 through the retained DeepSeek connection. The earlier packaging/install cells above describe the initial validation; these specific repairs are now installed. The live selected-tab and containment gates remain separate.
