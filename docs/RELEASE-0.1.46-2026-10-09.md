# Release 0.1.45 and 0.1.46, overnight 8–9 October 2026

**What this does not establish.** There is no customer acceptance, no live REI read and no Mac release (the signed Mac files are not uploaded yet). Windows evidence comes from one UTM VM (RealBud-Win11) plus the CI Windows runner. The sign-in code (website PR #35) is not deployed.

## Published
- **v0.1.45** (5257da5c): repeats from chat, behind an approval card on RealBud's clock (security-reviewed), plus the 0.1.45 fixes.
- **v0.1.46** (2bc5b17e, Latest): staged setup gating and the desktop app task card fixes.
- realbud.app/download serves v0.1.46 for Windows. Mac stays a 404 until the owner runs `mbp-sign-release.sh 2bc5b17e… 0.1.46` on the MacBook Pro.

## Evidence
| Check | Result | Tier |
|---|---|---|
| Full local gate before each merge | 10,429 (0.1.45) and 10,485 (0.1.46) passed; the one 0.1.46 failure was a stale test, fixed | local tests |
| Package Windows, dispatched explicitly on the release SHA | both jobs green for 37800685964 and 37814143931 | packaged build (CI Windows) |
| VM upgrade 0.1.42 → 0.1.45 → 0.1.46 | exit 0; health shows the new version within 50 s; link and data kept | installed device (VM) |
| Real cua desktop task (Notepad) | 0.1.45 and 0.1.46 both typed and read back the text, nothing saved | installed device + live model |
| Staged setup on device | Desk "2 of 5"; status bar "Setup 3 of 5 · Import your office's pack" | installed device |
| Mac isolated run (0.1.43): link, Bud ready, live Gmail read | passed | installed device + live integration |

## Also live tonight
- realbud.app: the link page can disconnect when the office is full; owner-path recovery fixes; sign-in keeps its target.
- Gateway v25 (f4845b1a), with new-mail triggers configured.
- The deploy guard that refuses while migrations are unconfirmed.

## Open
1. Mac signing: the owner runs it on the MBP; the notary profile is missing there (`scripts/store-notary-credentials.sh`).
2. Website PR #35 (emailed sign-in code): needs the migration and Supabase email templates first.
3. Repeats: the Gmail draft save is not built (no safe background path). A live model proposing a repeat card is unverified.
4. Desk still shows a Hermios tab on Austin computers (owner decision, Windows #27/#52).
5. UX sweep items still queued: `docs/UX-DEAD-ENDS-2026-10-08.md`.
