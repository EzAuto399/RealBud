# Product brief — RealBud layer + adopted QM kernel + dual-desktop Hermes host

Date: 2026-09-16  
Status: diagnostic (product-lens + product-manager). Not an implementation contract.  
Checkout: `/Users/yoda/projects/realbud-managed-gateway` (source of truth). Do not implement this in `/Users/yoda/projects/RealBud` (`main`, no company kernel).  
Does not replace `docs/PRODUCT-BRIEF.md` (original PM wedge) or `docs/GOAL-PROMPT.md` (canonical constraints).

**Go / no-go:** **GO** the already-decided two-desktop architecture. **NO-GO** installing QM as a runtime, sharing `~/.realbud` / Hermes homes, or refining this in the RealBud `main` checkout.

Next lane after approval: capability/eng plan in the **gateway** tree (`/plan-eng-review` or `product-capability`), starting at native member sign-in + shared-work → Ask. Not a new platform rewrite.

---

## 1. Who is this for

Named office: **Auston**. Named operators: **Kevin** on an existing Windows desktop that will host, and a **second desktop** that may be Kevin again or a second staffer. Design for two **device** identities and the ability to support two **members**. Do not invent a second person just because there is a second PC.

Not: DIY landlords, a Hermes.app shop, a second Bud, or “agencies in general.”

## 2. Pain (what they do today)

Two people (or one person on two PCs) cannot share one RealBud office.

- Each install is a private local Desk (`desk.json` / Ask threads / `loops.json`).
- Copying or NAS-mounting `~/.realbud` or `~/.hermes` creates two clocks, two writers on `state.db`, and machine-bound keys that will not decrypt.
- Closing RealBud on **Windows** (the intended host OS) **quits the office** (`electron/main.mjs` `window-all-closed` → `app.quit()`).
- That same PC must still run Excel / PMS / browser. Interactive Cua today can drive the person’s open browser (`USE_OPEN_BROWSER`) from the same session.

Frequency: every weekday. Cost: morning work does not exist unless the app is open; the second PC looks “connected” but has an empty or different Desk.

## 3. Why now

Auston chose the RealBud office-host direction. D02 is already **verified**: adapt QM’s PostgreSQL grant / knowledge / claim **semantics** in RealBud modules. Company preview join exists. Physical two-Mac kit proved TLS join + private-scope 404 + dormant templates. `officeReady` is still **false**. Remaining work is product cutover, not another architecture contest.

## 4. 10-star version

Desktop 1 runs a **background office service** (Postgres, one clock, receipts) that survives closing the window. Both people sign in as themselves. Each has a **private stock Hermes** home. Shared cases show the same revision on both PCs. Files stay on their computer until an approved copy is made. Overnight briefs run if the **service** is awake. Cua only runs on a named unlocked session after the human yields. Host CPU is measured so Excel still works. Windows 11 is the accepted pair.

## 5. MVP (smallest proof of the thesis)

On two machines, with synthetic data:

1. Desktop 2 **signs in as a member** (not just “host reached”).
2. Kevin publishes one **reviewed shared-work** item; Desktop 2 opens the **same revision**.
3. Ask on Desktop 2 can use that item as **read-only context**, then `respondToSharedWork` with a selected excerpt. Private notes stay 404.
4. No interactive Cua on Desktop 1 while a human uses Excel. Morning work, if any, is **non-GUI**.
5. Closing the RealBud **window** on Windows either keeps the office up **or** both clients say the office stopped. No silent second host.

That is enough to prove “RealBud layer uses the adopted kernel + two desktops + host still a staff PC.” It is **not** two private Hermes, not Windows 11 customer PCs, not overnight 7:30 with the lid shut.

## 6. Anti-goals (say no)

| Do not build | Why |
|---|---|
| QM runtime / Docker / harness / pg-boss / scheduler | D02 closed. QM harness list has no Hermes. Second clock. |
| Shared folder / NAS `~/.realbud` / “storage on desktop 2” | Independent installs with copied DBs. Plan forbids it. |
| Extra RealBud agents or Hermes.app | Goal: one Bud, stock Hermes behind the adapter. |
| Interactive Cua on the host while they type | Same session as the human. T34 unsolved. |
| Implementing in `/Users/yoda/projects/RealBud` | No `server/company/`, pin is 0.20.3-only, GOAL is one PM. |
| `compose-job` presets on RealBud `main` | Single-user Schedule work. Not this initiative. |
| Hermes 0.21.3 without an admission pass | Newer than the support list; writer-handle notes. Stay on **0.21.2**. |
| Silent reclaim of expired claims | Kernel returns `recovery_required`. Do not auto-requeue. |

## 7. How we know it is working

North star (commercial): **verified PM minutes returned per named PM per week**, with zero unauthorised send/pay/notice/submit.

For **this** slice, the office is working when all of these are true on recorded receipts:

- `officeReady` can be argued from **native member sign-in + same shared-work revision on both clients + private 404**.
- Duplicate click / two clients on one occurrence → **one run**.
- Window-close on the host → **honest** office-up or office-down, never a second scheduler.
- No Cua input into Excel/PMS while the human has the screen.

Local unit counts (500+ company tests) do **not** tick this.

---

## Founder review (this repo)

What it is trying to be: a **supervised office layer** over stock Hermes for Australian PM work, now stretching from one local desk to **one company host + two staff PCs**.

| Signal | Score | Note |
|---|---|---|
| Usage growth | 2/10 | Practice Macs and kits, not a live office weekday |
| Retention | 2/10 | No returning named PM on this topology |
| Revenue | 4/10 | Auston quote exists; not signed proof of two-desktop scope |
| Moat | 7/10 | Exact-action receipts, no-send, one clock, stock Hermes (hard to copy honestly) |

**10x:** one named office where both PCs share **one** case and the host PC still does ordinary work. Not more surfaces.

**Does not matter for this slice:** inbound mail, Pocket, law shelf, QM Docker, compose-job, 0.21.3, CRM.

---

## What five search agents found (2026-09-16)

### Adopted QM vs RealBud layer

- Kernel is real: `server/company/` grants, knowledge revisions, case claims, invitations. Postgres tests exist.
- Desk / Ask / Schedule / job-executor / routines **do not import** the kernel. They still own `desk.json`, `bots.json`, `loops.json`, `job-runs.json`.
- Company is a **sidecar**: setup card, SharedWorkPanel, dormant workflow templates. Preview copy in `server/company-host.ts`: personal Desk/Ask/schedules remain local; workers unavailable until isolation + enrolled devices.
- `claimCase` is **forbidden** on shared-work scopes. Text handoffs cannot become worker leases.
- Smallest real wiring: accepted shared work → Ask read-only context → `respondToSharedWork`. Then, for **jobs**, `claimCase` on a **general** scope while `LoopManager` stays the only clock.

### Stock Hermes on both desktops

- Every launch path uses profile **`property`**. No member-scoped resolver (W01 planned).
- Recommended admitted runtime: **0.21.2**. Rollback pin **0.20.3**. 0.21.3 not admitted.
- Ask ACP and Prepare CLI can both write the same `property` `state.db`. Upstream forbids two writers.
- One-Mac installed Ask/Prepare proof exists. Peer worker and Windows 11 do not.

### Host + usual tasks / performance

- Windows close-last-window **kills** server, Postgres, Hermes, Cua.
- No launchd / Windows service. H05 in progress as a gate, not a receipt.
- Computer lease is in-process, TTL ≤ 15 min, expiry ≠ old controller dead. ACP can still mount raw Cua.
- No CPU/RAM budget vs Excel. `simulate-scale.mjs` is book size, not host contention.
- Smallest host-as-staff proof: **non-GUI** morning job + visible Stop + Excel still usable + window-close honesty. Do **not** Cua-click the same session.

### Two-desktop join / files

- Code does **not** share `~/.realbud`. Ask attach **copies bytes**, rejects source paths.
- Latest physical: Mac mini helper “encrypted-company” + byte-identical spreadsheet mode 0600. Native member sign-in **unverified**. Complete peer receipt **not retrieved**. `officeReady: false`.
- “Prepare storage on this computer” is **host-only Postgres**. Desktop 2 must **Join**, not Set up host.

### Checkout drift

Implement in **gateway**. RealBud `main` has no company kernel, no two-desktop docs, Hermes pin-only 0.20.3. Uncommitted `compose-job` there is unrelated Schedule UI.

---

## Opportunity (RICE)

Reach = Auston two desktops (and the next office that copies the installer). Impact 1–3. Effort relative.

| Work | R | I | C | E | RICE | Call |
|---|---:|---:|---:|---:|---:|---|
| Shared-work → Ask respond (use kernel now) | 5 | 2.0 | 0.9 | 1 | 9.0 | **Now** |
| Native member sign-in + peer receipt | 8 | 3.0 | 0.8 | 2 | 9.6 | **Now** |
| Hold Cua while staff use the host screen | 8 | 3.0 | 0.85 | 2 | 10.2 | **Now** |
| Job `claimCase` on general scopes (one clock) | 8 | 2.5 | 0.75 | 3 | 5.0 | Next |
| Host service independent of Electron (H05) | 10 | 3.0 | 0.7 | 5 | 4.2 | Next |
| Per-member Hermes homes + exclusive writer (W01–W03) | 10 | 3.0 | 0.65 | 5 | 3.9 | Next |
| Second-member Composio accounts | 6 | 2.5 | 0.6 | 3 | 3.0 | Next |
| Windows 11 installed pair | 8 | 3.0 | 0.45 | 6 | 1.8 | Later |
| QM runtime adoption | 3 | 1.0 | 0.2 | 8 | 0.1 | **Cut** |
| Shared-folder “storage on PC2” | 3 | 0.5 | 0.9 | 2 | 0.7 | **Cut** |

ICE (same ranking, 1–5): Cua-hold 7.5, shared-work→Ask 10, native sign-in 6.7, H05 4, per-member Hermes 3.8.

---

## Now / Next / Later

**Now (this week, gateway checkout)**  
1. Finish native join: complete peer receipt, **member password sign-in** on Desktop 2.  
2. Shared-work accept → Ask context → respond. No `claimCase` on work-item scopes.  
3. Product rule: interactive Cua **holds** if the host session is in human use. Morning jobs stay non-GUI.  
4. Stop treating “encrypted-company” helper as login.

**Next**  
5. H05: host service survives window-close on Windows; clients show degraded status if it does not.  
6. W01–W03: server-owned per-member Hermes; queue Ask vs Prepare; one writer per home.  
7. Company-scoped job attempt: `createCase` / `claimCase` / `settleClaim` with `LoopManager` still the scheduler. Expired → held, not requeued.  
8. Bind Gmail/Calendar to the signed-in member (not the legacy one-user Composio).

**Later**  
9. Windows 11 host + client acceptance (not Server CI).  
10. Move/restore office; fence old host.  
11. Overnight briefs only after the **service** is proven awake.  
12. Dedicated host or VM **only if** they need GUI automation while using the same screen.

**Not building:** QM install, NAS desk, extra agents, inbound/Pocket, 0.21.3, compose-job-in-A.

---

## User stories (MVP)

1. As Kevin on Desktop 1, I set up **this office** once. Closing the window does not secretly start a second office on Desktop 2.
2. As a person on Desktop 2, I **join** and sign in as myself. I see shared work I am granted. I do not see Kevin’s private notes or Ask.
3. As either person, when I accept a shared item I can Ask about **that excerpt** on my PC. Bud does not read the other person’s Hermes memory.
4. As Kevin using Excel on the host, Bud does not move my mouse. If a GUI job is requested, it waits or I tap Stop.
5. As the office, one occurrence is one run even if both of us click.

Acceptance: the T-IDs already listed in `docs/REALBUD-TWO-DEVICE-ACCEPTANCE-2026-09-15.md` T01, T04, T07, T11, T14, T17, T23, T34. Do not invent a parallel list.

---

## Technical considerations (constraints, not a spec)

- RealBud owns clock, jobs, approvals, receipts. Stock Hermes unmodified. `cron_mode: deny`.
- Company Postgres is host-local. Clients use the company API. No SQLite/JSON/Hermes on a network share.
- Member session ≠ device enrolment ≠ loopback `SESSION_TOKEN`. Do not expose the localhost admin API on the LAN.
- `HERMES_SAFE_MODE=1`, `HERMES_EXEC_ASK=1`. Cua 0.19.3 is not Hermes’ 0.20 computer-use contract; do not assume a pin bump fixes Cua.
- Windows Session 0 cannot drive the staff desktop. Service + interactive companion are different processes.

---

## Pre-mortem (launch day failed — why)

1. Staff closed RealBud on Desktop 1; Desktop 2 showed Connected; nothing ran. **H05 not done; UI lied.**
2. Two Hermes processes wrote one `property` profile; memory/skills corrupted. **W01/W03 skipped.**
3. Bud clicked the PMS while Kevin typed. **Cua not held.**
4. Desktop 2 Ask was empty after join. **H08 still local.**
5. Someone “turned on QM” and morning money ran twice. **Second clock.**
6. Desktop 2 used Set up host because the installer offered it. **Two offices.**
7. Work happened in RealBud `main`. Company kernel never ran.

Prevention is the Now list. Recovery: one host, fence the other, restore from host backup, not from a client copy.

---

## Scope-creep log (this request)

| Request | Impact | Decision |
|---|---|---|
| “QM integration we adopted” | If read as QM runtime: weeks + second clock + no Hermes harness | **Adopted = kernel semantics only.** Already verified D02. |
| “Hermes agent on both desktop users” | Per-member homes + exclusive writers. Large. | **Next**, after sign-in + shared-work Ask. Today both would share `property` or two disconnected locals. |
| “Main one host and operational for usual tasks” | Background service + no Cua steal + measured load | **Split:** Now = no mouse steal + honest window-close. Next = real service. |

Every yes above is a no to inbound, Pocket, and a QM install.

---

## The assignment (one real-world action)

Sit at **both physical machines** in the gateway checkout’s current two-Mac pair. Retrieve the **complete peer receipt**. Sign in as a **member** on Desktop 2 (password, not helper status). Publish one shared-work item from Desktop 1 and open it on Desktop 2. If member sign-in fails, that is the only Now engineering task. Do not start Hermes-per-member or H05 until that receipt exists.

Handoff: implement only in `/Users/yoda/projects/realbud-managed-gateway`. After this brief is approved, lock the Now slice with an eng review — not a new QM spike.
