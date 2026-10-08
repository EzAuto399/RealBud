# Kevin's PC setup: Friday 9 October 2026, 9:30

Goal: RealBud installed on Kevin's Windows PC and ready for Monday. Kevin signs in to Gmail and Redbark on his own screen, and auto-update has to work from then on. Bud never handles passwords, and neither do we: Kevin types every password himself. Install click path: [Austin showcase on Windows](AUSTIN-WINDOWS-SHOWCASE-2026-10-09.md).

## Before leaving (owner)
1. **Release.** realbud.app/download must show the version that passed the VM install-and-update run (0.1.42 or 0.1.43). If no newer release has passed, stay on 0.1.41.
2. **Link code.** realbud.app → Computers → Pair a new computer.
3. **Gmail for this office** (realbud.app → Computers):
   - **Shared**: one office mailbox, granted computer by computer. Use **Create Gmail connection link** and open it on Kevin's PC so he signs in to the office Google account himself. Then type the intended address, choose **Approve this office mailbox**, and choose **Allow Gmail access** for Kevin's computer once it is linked. The mailbox is read-only until you choose **Turn on full access**.
   - **Personal** or **Both**: Kevin connects his own Gmail from RealBud ("connect gmail" in Work).
   - In shared mode, Kevin's own "connect gmail" is refused by design. From 0.1.43 the refusal names this path.
4. **Workflow packs** uploaded (realbud.app → Workflow packs).
5. **Ask Kevin**: Smart App Control is Off, and Settings › System › About does not say "S mode". Otherwise Windows blocks the unsigned installer.

## On site
1. Install from realbud.app/download (about 1–2 min). Then the link code, then **Continue to Bud setup**. Bud sets itself up in about 20 min. Keep RealBud open. If the window is closed, the office service keeps running and reopening RealBud picks it up again (seen on Mac, 8 Oct).
2. **Gmail**: follow the mode chosen above, then Workspace → Connected apps → **Check access**.
3. **Redbark**: Workspace → Connected apps → **Bank feed (Redbark) → Connect bank feed**. Kevin signs in at app.redbark.com in his browser, and RealBud gets read-only access (`mcp:read data:read`). The connection belongs to this computer, so Sherry's PC needs its own. Still open: whether Redbark accepts ANZ business/trust accounts.
4. **Remote help for later**: RealBud has no remote-control feature, so use an outside tool. Windows Quick Assist needs the helper on Windows, so it can't be run from the owner's Mac. Use Chrome Remote Desktop (remotedesktop.google.com/support) or AnyDesk; both work Mac → Windows. Kevin shares a one-time code. Kevin types his own passwords while we look away.
5. **Before leaving**: Work → "What needs me today?" gets an answer, the status bar says Connected, Gmail and the bank feed show Connected, and the version shows bottom right.

## Auto-update (Windows)
RealBud checks GitHub 15 s after launch and then hourly. A card shows "RealBud 0.1.x is available", then **Download**, then **Restart to update**. There is no admin prompt, and the data folder (`%USERPROFILE%\.realbud`), the office link and the connections are kept.

From 0.1.42 the restart waits while Bud is working or still setting itself up; a setup that was stopped never holds it back. A "could not stop the service" result retries once by itself. Releases are now published draft-first, so a client never sees `latest.yml` before its installer.

Mac builds are unsigned and can't auto-update: reinstall from the .dmg.

## Evidence, 8 October
| Item | Result | Tier |
|---|---|---|
| Isolated 0.1.41 linked to the owner's test office | Linked at once; Bud ready about 20 min later; first answer within a minute on Sonnet 5.5 | installed device (Mac) |
| Bud's mounted tools at runtime | memory proposals, read_page, sign-in, reminders, saved views, workflow settings, bank (2 read tools), decisions | installed device (Mac) |
| Shared-mode Gmail refusal | Refused correctly; copy didn't say where to go, fixed in 0.1.43 | installed device (Mac) + local tests |
| Gmail and Redbark live connect | **Not run**: waiting on owner sign-ins | — |
| Session search (state.db) | Broken on every Mac install (sandbox blocked Hermes' folder check); fixed in 0.1.43, proven on the pinned runtime under the real sandbox | local tests + pinned runtime |
| Unpinned tirith download | Hermes tried it on every turn (the sandbox blocked it); switched off in 0.1.43 | local tests + pinned runtime |
| Windows 0.1.41 → 0.1.42 in-app update | Run by the "Loading screen coverage" session on the VM | see that session's receipt |

## Open
- Owner decision: during a person-started browser task Bud drops its bank, Gmail, reminders and CRM tools. The fence keeps a browser task to its scoped tools, and widening it is an authority change.
- Enterprise gaps, not blocking Friday: unsigned Windows installer; Bud's Hermes state is unencrypted at rest (owner-only folders); backups are manual only; no network sandbox on Windows.
