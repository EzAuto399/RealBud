# Next wave

Date: 2026-08-29  
HEAD at writing: `750f7ae`  
Canonical constraints: `docs/GOAL-PROMPT.md` wins conflicts.

This is the pickup list for later sessions. W1–W5 shipped on `cursor/next-wave-tasks-fa2e`. The remaining hole is a named office (`docs/PILOT-CONTRACT.md`), not more Desk chrome.

If a later idea fights this file, `docs/GOAL-PROMPT.md` still wins.

Related: `docs/LLM-BRIEF.md`, `docs/PRODUCT-DESIGN-PLAN.md`, `docs/PILOT-CONTRACT.md`, `TODOS.md`

---

## What is already true

Shipped on main, 500 tests, e2e walkthrough green:

- Four places only. Desk V3 book. Warm Ledger tokens.
- Morning money and Friday owner letter. Editable clock. Copy only. Send 403.
- CSV match by address or property code. Row-level holds. Notes isolated from evaluate.
- Ask can put courtesy on Desk and paste or drop a book into staged cards.
- Worker install, model attach, and recovery-key unlock are in-app.
- Pilot contract is still the Demo Book. No named office.

Do not rebuild any of that.

---

## What we keep getting wrong

These are the same misses, twice or more.

**Built, then left unmounted.** `src/components/Onboarding.tsx` has the three rules. `App.tsx` never imports it. `emailGateDone()` in `src/lib/analytics.ts` always returns true. Blind-spot #2 in `docs/PRODUCT-DESIGN-PLAN.md` named this on 2026-08-25. It is still true.

**Handoff docs lie after a ship.** `CLAUDE.md` still says owner-letter is declared. The plan's T1 to T13 boxes are still empty. `docs/GOAL-PROMPT.md` §8 is dated 2026-08-23. The next session then re-plans V3 or starts inbound.

**T12 was specified as Ask-as-actor, shipped as intake.** The plan asked for `run-loop`, `retune-clock`, `add-property`, `edit-property`. What landed is paste-a-book plus "Put courtesy on Desk". Clock-from-Ask stays deferred (ROUTINES PR C). Do not "finish T12" by building PR C.

**T11 claimed a vocabulary purge.** Desk still prints "Hermes live". `ModelPicker` still says Hermes. Settings still mention `hermes -p property`. Advanced diagnostics is the only place that word is allowed.

**Blind-spot register, then only T13.** The Aug 25 sweep listed nine gaps. Recovery escrow shipped. First-run, last-checked times, retention, and `safeStorage` did not.

**Architecture ahead of the office.** GOAL-PROMPT already said this. Then V3 shipped anyway. That platform is useful. Starting inbound mail, live CUA, Pocket, or a law shelf before `docs/PILOT-CONTRACT.md` has eight named fields is the same mistake again.

**Allow-all is a loop of full commits.** Desk "allow all" book proposals calls `/allow` once per property. Each `addProperty` does the encrypted commit (~38ms). A real book will feel broken. Tracked as the T2 follow-up.

**A previous cloud run sat on "Hi".** No task, no branch, idle. If the prompt is empty, stop.

---

## Do not start

These look like product completion. They are not the next session.

| Item | Why it waits |
|---|---|
| Inbound-triage mail (IMAP/Graph) | Declared loop. Needs a named inbox and a named office. |
| Ask proposes a clock change (PR C) | Deferred until an office asks. |
| Property scope on a loop (PR D) | Fixture ids are not a book. |
| Live portal / PropertyMe read API / Pocket | `docs/PILOT-CONTRACT.md` eight fields first. |
| Cmd+K, PropertyGroup UI, J/K, lease-review, inspection-prep | Chrome and declared case kinds. Not the graduate path. |
| T17 notarize / signed Windows | Release gate. |
| OpenMausBot leftover files (`GroupView`, Plugins, mascot) | Product mode already hides them. A purge is tempting and is not the hole. |
| Funding a model key | Human. Not a code task. |

The human task that actually finishes the product is still the visit: fill the eight fields in `docs/PILOT-CONTRACT.md`. Code cannot invent an agency.

---

## Shipped this wave (2026-08-29)

- **W1** First-run three-rules screen + Desk/You go-live card (export / worker / agency). Demo agency name does not count.
- **W2** Partial worker ledger holds uncovered properties. Chip stays Held. User chrome says Worker, not Hermes.
- **W3** `Desk.batch` / Allow-all one persist. 194 adds are one revision bump.
- **W4** Electron wraps `desk.key` with `safeStorage`. `REALBUD_DESK_KEY` does not write a plaintext key file.
- **W5** You sources show last-checked in the agency timezone. Desk Recheck and Test hands share `~/.realbud/hands-last.json`.

## Next sessions (unblocked)

One session, one row. Tests first on gate and persist code. After Desk UI changes, run `node --experimental-strip-types scripts/e2e-walkthrough.mjs`.

### W1. Mount first-run and the go-live card — shipped

The three-rules screen exists and is dead. First launch opens Desk with no framing.

- Import `Onboarding` from `App.tsx`. Gate it on a real first-run flag, not `emailGateDone()` returning true.
- On Desk, a dismissible three-row card: Connect your export, Attach your worker, Name your agency. Done / ready / action. It disappears when all three are green. "Replay sample morning" stays after go-live.
- No wizard modal beyond the existing two-step welcome. No new nav place.

Files: `src/App.tsx`, `src/components/Onboarding.tsx`, `src/lib/analytics.ts`, `src/components/DeskPage.tsx`, `src/components/YouPage.tsx`.  
Done when: a wiped profile sees the three rules, then Desk, then the checklist. Recheck, Allow, Copy still work.

### W2. Hands honesty — shipped

A subset Hermes answer still flips the chip to live and leaves uncovered properties on stale facts (`TODOS.md`, `server/hermes-hands.ts`). User chrome still says Hermes.

- Compare returned ledger ids to the requested set. Missing ids become a hold (`uncovered-by-worker`). Chip stays held, not live.
- User-facing copy: "Worker live", "CSV live", "Held", "Demo". "Hermes" only inside Advanced diagnostics.

Files: `server/hermes-hands.ts`, `server/desk.ts`, `src/components/DeskPage.tsx`, `src/components/desk/DeskBook.tsx`, `src/components/ModelPicker.tsx`, `src/components/SettingsPanel.tsx`.  
Done when: a fixture with one property omitted from the worker JSON holds that property, and a string search of user chrome for `Hermes` is empty outside Advanced.

### W3. One commit for a bulk book write — shipped

`addProperty`, CSV-backed adds, and Allow-all intake each persist once per row. The 200-property test already carries a 30s budget.

- Batch persist: one encrypt/fsync/backup at the end of a bulk add, import, or Allow-all.
- Desk "Allow all" must not N sequential HTTP commits.

Files: `server/desk-store.ts`, `server/desk.ts`, `src/components/DeskPage.tsx`.  
Done when: 194 adds stay well under the 30s budget, and Allow-all is one revision bump.

### W4. Wrap `desk.key` (`T16`) — shipped

The book is encrypted. The key sits next to it as plaintext. `server/desk-key.ts` still describes `safeStorage` as a comment. Do this before any graduate installer.

- Electron wraps `desk.key` with `safeStorage` and passes the unwrapped key to the server child.
- Source runs stay labelled non-production.
- Provider keys stay out of `desk.json` and logs.

Files: `server/desk-key.ts`, Electron main process.  
Done when: a production-labelled run has no raw 32-byte key file beside `desk.json`.

### W5. Last-checked on You sources (`T14` subset) — shipped

Missed runs and held sources are silent unless the PM is already looking. OS notifications can wait. Timestamps cannot.

- Each source row on You shows last-checked time and freshness.
- Schedule already has a failed/missed dot. Do not add a new notification permission this session.

Files: `src/components/YouPage.tsx`, snapshot source fields if they are missing.  
Done when: You names when CSV and worker were last checked, in the agency timezone.

---

## After this wave

Then stop and wait for a named office, unless that office asks for one of:

1. Installer a graduate can double-click (Windows stays CSV-only until a worker is bundled).
2. Vendor-test portal, human Submit.
3. Retention sweep (`T15`) if disk or privacy comes up on the visit.

Do not start inbound, PR C, Pocket, or a second agent to "complete" the product.
