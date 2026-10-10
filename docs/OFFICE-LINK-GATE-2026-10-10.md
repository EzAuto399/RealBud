# Office link gate, 10 October 2026

**This does not establish:** packaged or installed behaviour, a live link with realbud.app, or customer acceptance.

Owner decision (10 Oct 2026): every RealBud computer links to its office before anything else opens. There is no sample-desk or "without Bud" exit. Recovery is the only way past the screen.

## Product, user, job
- **Product:** every RealBud computer works for one office, and nothing opens until it is linked.
- **User:** office staff on a new or newly updated computer.
- **Job:** paste the link code the owner sent. This happens once per computer, and again only after the office disconnects it.

## Happy paths
1. **New computer.**
   1. Welcome: name and optional email, then Continue.
   2. "Connect this computer to your office": paste the code, then "Connect with this code".
   3. Once connected, "Continue to Bud setup" opens Bud's setup screen, and then Desk.
2. **Updated computer that never linked.**
   1. RealBud opens on "Connect this computer to your office".
   2. The person pastes the code.
   3. Bud's setup screen opens if Bud isn't ready; otherwise Desk.

## State matrix (the gate takes the shell's place)
| State | Shown | Next action |
|---|---|---|
| Checking (link or book not read yet) | the screen frame only; "Checking this computer's office link…" after 1 s | none (it resolves) |
| Not linked | heading, one line, link-code form, "Copy request for your owner", owner browser approval | Connect with this code |
| Waiting for browser approval | the code on this computer, time left | Open the page again / Cancel |
| Computer limit | alert, code kept | Copy request for your owner (free a place) |
| Disconnected (revoked) | "This computer was disconnected from your office" and "Everything saved here is kept." | Connect with this code |
| Can't be read (local service failed, or the book didn't answer within 20 s) | "RealBud couldn't finish checking this computer" | Try again; Open recovery |
| Service reconnecting, last read not linked or revoked | the same link screen | Connect with this code once the service is back |
| Service reconnecting, linked or not read yet | no gate: the shell's own startup and reconnect screens | none (it resolves) |
| Linked | gate gone | Bud setup screen, or Desk |
| Book in recovery | no gate | recovery first |
| Recovery started in first run, not finished | link screen with "Continue recovery" | Continue recovery, or link |

## Edge paths
- **Wrong code:** an inline alert, and the typed code is kept.
- **Interrupted:** a browser approval is restored when RealBud reopens. An interrupted code redemption asks for the same code again.
- **Offline:** the link is read from this computer's own record, so being offline never blocks a linked computer.

## Exits
- First run keeps "Restore a private backup" and, for a protected book, "Open recovery".
- Once recovery is started there, the link screen offers "Continue recovery" on each launch. That lasts until recovery finishes or the person returns to welcome. A saved recovery stage never skips the screen by itself.
- The gate keeps "Open recovery" only when the link can't be read.
- Each of these lets the person past the screen for the current app session only.
- QA scripts skip the screen through `primeBrowserSession` (`scripts/local-session.mjs`). No screen sets that flag.
