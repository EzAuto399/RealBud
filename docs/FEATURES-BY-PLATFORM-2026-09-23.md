# Features by platform — 23 September 2026

What this does not establish: no feature here has run on a customer machine, and neither platform
ships a signed build. "Installed hosted runner" means an unsigned NSIS install on GitHub's
`windows-latest`, not an office computer. Passing platform checks is not the same as a feature
being available: the rows below name the code that holds a feature back.

Evidence tiers: source → local tests → packaged build → installed hosted runner → real device →
customer. Update this table whenever a row changes tier; it is the acceptance list for
"works on Windows and macOS".

| Area | Feature | macOS | Windows | Holding code | What proves it next |
|---|---|---|---|---|---|
| Setup | Browser link to the RealBud account | local tests + desktop↔website end to end (loopback) | same code, not run on Windows | — | Installed run on both against the deployed website |
| Setup | One join code for a second computer | local tests + rendered | same code, not run on Windows | — | Two-device run |
| Model access | Modelvia key provisioning, recovery, cap sync | live against local Modelvia (11 steps) | same code | — | Provisioning through the deployed gateway on an installed build |
| Mail | Gmail read-only history and morning priorities | local tests, fictional connector | same | — | Real Gmail consent (GATES §A) |
| Mail | Invoice attachment contents | not collected (metadata only) | not collected | `server/composio-gmail.ts` | Approved attachment acquisition through the evidence pipeline |
| Portal | Fenced browser runtime (read, prefill) | local tests, rendered | packaged helper shipped | — | Driven portal run on an installed Windows build |
| Portal | Attended computer control (CUA) | allowed by the live-portal gate | **held by policy** | `server/pilot-contract.ts:15` (`cuaHostSupported: darwin`) | Owner decision + a driven Windows session |
| Worker | Pack skills, skill preload, curated skill index | real Hermes 0.21.3 code, throwaway profile | same config | — | Packaged worker on both |
| Worker | Hermes' own browser and credential-vault tools (bypass route) | **0 offered** with dependencies present (real 0.21.3 code); driver cancels any Hermes `browser_*` call | same config | residual: agent-browser/npx in a system folder plus a Playwright Chromium under the person's home still exposes 14 (no 0.21.3 switch) | `scripts/testing/hermes-browser-boundary.mjs` on each Hermes upgrade; readiness check at install is an owner call |
| Browser | Task authority: Ask one-off tasks, saved jobs, delegated subagents on one broker; full actions (read, navigate, fill, select, keys, click, download with hash, upload of granted files, submit); pay/sign/send/notice as once-only approvals with page-verified recipient/amount/content; Stop and sign-in resume | local tests (514) + portal e2e; approval card rendered (component) | same code | — | A driven run on the real helper with a fictional pay form; installed runs on both |
| Worker | Memory review and proposals | local tests | **refused** | `server/hermes-memory-review.ts:74` (`platform-unverified`) | Windows per-file ACL + durable rename admission for the native store |
| Worker | Legacy personal Hermes profile migration | local tests | **refused** | `server/hermes-pack.ts:31` | An ACL-preserving migration protocol |
| Storage | Private data created protected | local tests | installed hosted runner | — | Real device |
| Backup | Export, preview, staged restore, cold apply | local tests | **installed hosted runner, 6/6** (restore up to 39 s) | — | Real device; restart; uninstall with data; data folders from older builds still refuse |
| Service | Office service start | packaged smoke | installed hosted runner (6.9–14.2 s) | — | Real device timing |
| Service | Crash restart (window open) | unit tests | unit tests | — | Kill-and-return on an installed build |
| Service | Supervision after the window closes | already kept (app stays in the dock) | unit tests: stays in the notification area when unattended work is on; sign-in host supervises | `electron/unattended-host.mjs` | Installed: schedule on, close window, kill service, one return, no duplicate run (steps in WINDOWS-PROFILE-ACCEPTANCE) |
| Service | Start at sign-in, keep awake | component tests; login item opens the window | component tests; `--service` headless | `electron/service-persistence.mjs` | Real reboot + sign-in |
| Company | Hosting an office (owned PostgreSQL) | local tests | installed hosted runner | — | Real device |
| Speech | Dictation helper | packaged build | packaged build | Linux unsupported (`electron/speech.mjs:48`) | Driven microphone session |
| Release | Signing and updates | **unsigned, not notarized** | **no Authenticode certificate** | `electron-builder.yml` | Certificates (owner gate, GATES §B) |

Biggest gaps by user impact: unsigned builds on both platforms; memory review refused on
Windows; attended computer control held to macOS by policy; browser task authority not yet driven
on the real helper; attachment contents never collected.
