# Austin workflows: how each one runs

Owner design, 6 October 2026: Bud runs Austin's five workflows on its own, notifies the right person, and pauses for a person only where a person is truly needed. The main pause is signing in to REI Cloud. When Kevin arrives and signs in, the waiting work continues from where it stopped. Everything is packaged as the Austin pack: install on the office PC, link the office, sign in to Gmail, Redbark and REI on their own screens, then review each workflow and switch it on.

Evidence tier for this document: design. Each workflow below names the code and QA that prove what is built. Customer acceptance happens at Austin.

## The rules every workflow follows
- **Runs on the office PC:** times are in the office timezone (Australia/Brisbane). If the PC is off or asleep, the run shows as missed or late, never as done.
- **Waits for a person only to sign in, approve something, or decide something:** while one workflow waits, the others keep running.
- **Picks up where it left off:** finished steps are saved and never redone after a restart or sign-in.
- **Never submits on its own:** uploading to REI, paying, sending and issuing notices each need a one-time approval that shows the exact item. Reads and exports don't change anything.
- **Notifies once:** a card in Work plus a desktop notification, and at most one reminder.
- **Keeps the office's data on the office PC:** sign-in sessions stay in the work browser, and Bud never copies cookies or types passwords.

## W1: Kevin's bank references → REI Cloud
| | |
|---|---|
| When | Every 2 days at 08:00 |
| Needs | ANZ export (Redbark link, or a CSV dropped into the bank review), the REI tenant list (saved via Refresh from REI) |
| Steps | 1. Pull the ANZ rows. 2. Match each row to an REI tenant: code, unit notation, street, payer name. 3. Write REI's tenant Reference into the last column; list exceptions with reasons (amount ≠ rent, bond, business transfer, unknown). 4. Kevin reviews the exceptions. 5. **Wait at the REI login page until Kevin signs in.** 6. Ask to upload the reviewed CSV, as one approval showing the exact file. 7. Read back what REI accepted. |
| Waits for | REI sign-in (the page stays open all day, and Bud notices the sign-in by itself); review of exceptions; upload approval |
| Notifies | Kevin: "Sign in to REI Cloud so Bud can finish the bank import", then "Ready to upload: 14 matched, 9 to check" |
| Resume | After a restart, the REI login page reopens and the run carries on from the next step. If nobody signs in by 18:00, the run is marked missed and the next run tries again |
| Proof | `scripts/qa-w1-simulated.mjs`, `qa-rei-signin-wait.mjs`, `qa-rei-login-wait.mjs` (in progress); real ANZ file 14/14 matched, 0 wrong (counts only) |

## W2: Kevin's council, water and levy bills
| | |
|---|---|
| When | Weekly, Monday 08:00 |
| Needs | Gmail (office connection), property rate numbers (from Kevin's Property.csv) |
| Steps | Collect bill emails and PDFs, match each bill to a property by council, water or levy number, show REI's last status as unconfirmed, learn each building's quarterly pattern, and flag bills that should have arrived but haven't |
| Waits for | Kevin's review of new bills and suggested patterns (no sign-in needed) |
| Notifies | Kevin: "3 bills to review, 1 expected bill missing" |
| Proof | `qa-weekly-bills.mjs`, `qa-w2-calendar.mjs`; real Property.csv imported 131 numbers, 4 rejected with reasons |

## W3: morning priorities
| | |
|---|---|
| When | Weekdays, starting 07:30 so it's ready by 08:00 |
| Needs | Gmail |
| Steps | Read new and unresolved mail since the last check, group it (urgent, to do, waiting, FYI), and keep staff decisions between runs |
| Waits for | Nothing. It's a list for the person |
| Notifies | The person: "Morning priorities ready: 4 urgent" |
| Proof | `qa-morning-mail.mjs` |

## W4: Sherry's maintenance checks and verified suppliers
| | |
|---|---|
| When | Weekdays at 08:30. **Supplier list check fortnightly**, Monday 08:15 |
| Needs | Gmail, REI Suppliers list (saved on the PC) |
| Steps | Check every maintenance invoice sender against REI's supplier list. A sender only counts as verified when Gmail's server confirms it (DMARC or DKIM); Xero relays are checked by Reply-To, and staff are asked to check bank details. Flag several invoices from one supplier for one property in a calendar month (by date received). The fortnightly check pulls REI's supplier list **and waits for REI sign-in like W1**, then shows added and removed suppliers and email changes for approval |
| Waits for | Sherry seeing findings; approval of supplier-list changes; REI sign-in for the fortnightly check |
| Notifies | Sherry: "Sender not verified: …" / "Several invoices this month: …"; the owner or Sherry: "Supplier list changed in REI: 2 added, 1 removed" |
| Proof | `qa-maintenance-review.mjs`, `qa-supplier-watch.mjs`, `qa-rei-directory-sync.mjs` |

## W5: Sherry's inspection planning
| | |
|---|---|
| When | Monthly, first weekday at 09:00 |
| Needs | Inspection history (CSV or REI later), Sherry's rules (inspectors, times, capacity, closed days) |
| Steps | Draft the next six months grouped by area, day and time. Accepted and moved visits stay put. Overdue and no-history properties are held with reasons |
| Waits for | Sherry accepting visits. Booking in Property Inspect is **not connected** yet: it needs Austin's Zapier/Property Inspect account |
| Notifies | Sherry: "New inspection draft ready to review" |
| Proof | `qa-inspections.mjs` |

## Bud learns REI and stays current
- **First visit:** in an attended Work task, Bud explores REI read-only and proposes how to export the Tenants and Suppliers lists. The person approves once, and Refresh from REI then uses that path. Any button that isn't already known to be safe asks every run (`qa-portal-learn.mjs`).
- **Settings:** working rules (inspection times, month rule) change through Bud's approval cards, and earlier versions are kept.

## Rollout path
1. Build and prove on Mac. Done for W1–W5, the live REI path in progress.
2. Windows installer from CI (`Package Windows` passes install checks). Then a Windows VM: install, office link, Bud setup, fictional demo, the REI login wait.
3. At Austin:
   - Install and link the office.
   - Kevin and Sherry sign in to Gmail, Redbark and REI on their own screens.
   - Run Refresh from REI once, review each workflow in Schedule and switch it on.
4. First fortnight: watch the runs and the misses, and tune times and rules through Bud.
