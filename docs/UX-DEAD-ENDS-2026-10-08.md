# UX dead ends: pattern and sweep, 8 October 2026

**What this does not establish.** This is a source sweep of the desktop app (main f399da96) and realbud.app (website main 1d07ab9), plus one live owner observation. No fix listed here is verified on an installed device or on the live site unless its row says so. Rows marked "fixing" are in progress, not done.

## Trigger

On 8 October the owner tried to link a fresh Kevin test computer. realbud.app's "Link this computer?" page said "This office already has 5 computers. Disconnect one to pair another." It offered no way to disconnect, and the request expires in 10 minutes. The desktop meanwhile kept saying "Waiting for your approval…", with no reason and no time left.

## The rule: recovery in place

Every blocked state has to:

1. **Name the real cause** and offer the fix as a control right there: a button, a link that comes back to this task, or **Copy request for your owner** when someone else must act.
2. **Show limits before the action**: counts such as "5 of 5", roles, preconditions and readiness. Disable the control with the reason, rather than refusing after the click.
3. **Survive the detour**: time-limited steps show time left, and leaving to fix a blocker doesn't reset or expire the task.
4. **Explain long waits**: show elapsed time, a realistic estimate and what can be done meanwhile.
5. **Never flatten the server's reason**: no mapping by status code to "expired" or "try again shortly".
6. **Make support reachable**: "Contact support" always says where (hello@realbud.app) and carries the context (office, computer, error), or points to Save support file.
7. **Confirm destructive switches**: anything that clears an approval, mailbox or grant asks first.

The rule is recorded in `.claude/rules/ui.md`, `.claude/rules/website.md` and the CLAUDE.md lessons.

## Patterns found (counts are instances in the sweep)

| Id | Pattern | Desktop | Website |
|---|---|---|---|
| P1 | Dead-end error: the fix lives elsewhere, with no control here | 9 | 6 |
| P2 | Late limit or precondition | 6 | 6 |
| P3 | Lost progress or expiry when leaving to fix a blocker | 3 | 4 |
| P4 | Owner-only step shown to staff with no hand-off | 8 | 4 |
| P5 | Misleading status | 6 | 7 |
| P6 | Silent long wait | 3 | 3 |
| P7 | No retry; "contact support" or "reload" is the only path | 2 | 5 |
| P8 | Support with no address or context | about 30 strings | every mailto |
| P9 | Server reason flattened by status code | 4 | 1 |
| P10 | One-time secret (code or link) can't be shown again but counts against a cap | — | 3 |
| P11 | Two surfaces disagree on the same step (onboarding vs Get started) | 1 | — |
| P12 | No setup home: owner steps have no checklist or progress | — | 1 |

## Highest impact

### Desktop (Kevin's from-zero path)

| # | Where | Problem | Status |
|---|---|---|---|
| D1 | Link-code redeem | The website's computer-cap 409 shows as "code expired", and the code is dropped | fixing (branch `claude/recovery-in-place`) |
| D2 | Waiting for browser approval | No time left, no reason, no "start again" | fixing |
| D3 | Get started → Enter link code | Opens the owner-only browser link first, with the code form collapsed | fixing |
| D4 | Owner-only steps (link code, office Gmail, bank feed, remove computer) | No hand-off to the owner | fixing (Copy request for your owner) |
| D5 | Connected apps on an unlinked computer | Says "service administrator", and Connect ignores whether Bud is ready | fixing |
| D6 | Schedule job on an unlinked computer | Says "Finish Bud's installation" | fixing |
| D7 | Resume a job | Enabled, then refused by the server | fixing |
| D8 | "Contact RealBud support" (about 30 strings) | No address | fixing |
| D9 | Model billing or key errors for managed staff | Point to settings staff can't use | queued |
| D10 | Restore | "Use a fresh desktop" shows only after a 1 GB upload and the passphrase | queued |

### Website (owner setup path)

| # | Where | Problem | Status |
|---|---|---|---|
| W1 | Link approval page at the computer cap | No disconnect; the request expires | fixing (branch `claude/link-limit-disconnect`, not deployed) |
| W2 | Pairing codes | Issued even when the office is full; unused codes can't be cancelled; "Hide code" loses the only copy | queued (SQL migration, needs owner) |
| W3 | Workspace access | Fresh sign-in is asked after pasting the code; the code is wiped and the person sent to /account | queued |
| W4 | Every /account sign-in | Drops the `next` target | queued |
| W5 | Invite opened with the wrong email | Sign-out loses the invite | queued |
| W6 | Gmail for this office, "unknown" state or wrong Google account | Only "contact support"; no reset or reject | queued |
| W7 | Pack upload | "Computers can now download it" without checking the signature; each computer then refuses it silently | queued |
| W8 | "Use personal Gmail" | Clears the approved shared mailbox with no confirm | queued |
| W9 | Revocation pending | Still takes a computer slot; tells the owner to contact support | queued |
| W10 | Overview | No setup checklist for pairing, Gmail, packs and access | queued |

The full ranked lists (25 per side, with file:line and the smallest fix) are in `outputs/ux-dead-ends-2026-10-08/{desktop,website}.md` on the build Mac. Rows move to "done" here only with a test or live receipt.
