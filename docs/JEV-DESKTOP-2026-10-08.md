# Jev, Luna and desktop-app tasks — 8 October 2026 (round 2)

Follows [cua-driver 0.34 and Jev tuning](CUA-034-JEV-2026-10-08.md). Branch
`claude/jev-round2`, merged to `main` after release 0.1.40, so 0.1.40 does not
include it. Evidence tier: source + local tests. Nothing here has run against
live Jev, live Luna, a real cua 0.34 daemon or the Windows VM.

## Owner decisions (8 Oct)

- Jev first for every text decision (final, overriding 0.1.41's "Luna first,
  Jev fallback"). GPT-6 Luna Decisions (`gpt-6-luna-decisions` via Modelvia →
  OpenRouter) reads images only (one screenshot of the selected window, when
  Jev answers "none", person-started tasks only) and is the text fallback when
  Jev's route fails (`jev-client.ts`: 502, 503 `model_route_unavailable`, a
  dropped connection or Jev's own 8 s timeout; key `<primary>:fallback`).
  Image calls never fall back.
- Env (dev/QA only; installed apps set none): `REALBUD_JEV_MODEL` (default
  `jev-1.13-decisions`, `off` = no decisions). `REALBUD_JEV_FALLBACK_MODEL` = the
  text fallback (default Luna; `off` disables it). `REALBUD_LUNA_MODEL` = the
  vision model and default fallback (default `gpt-6-luna-decisions`; `off`
  disables both).
- Desktop accessibility labels and roles (never values) and ledger column
  headers (redacted) may go to TypeSafe.
- Jev token usage is returned and counted in per-run cost.
- Unattended loops: label, don't hide (research-backed; see below).

## What changed

- **Desktop-app tasks.** A person picks one app window on the Ask task card
  ("or an app on this computer"). Bud gets a `workdesktop` broker, never the raw
  cua tools: one cua session per task, pid/window injected, token map replaced
  on every read, menu bar excluded. The desktop fence allows reads and ordinary
  navigation; pay/sign/send/submit/delete/notice need a per-instance card naming
  the app's real control label; sign-in controls and password fields are
  denied; a closed or changed window or app ends the task (a desktop grant has
  no account marker, so the card no longer promises an account check). Phones cannot start
  or answer desktop cards. The unused raw `computer` mount was removed.
- **`pick_control`.** Jev chooses among ≤64 labelled candidates
  (`PICK_MIN_CONFIDENCE` 0.75); otherwise Luna sees the window screenshot
  (`LUNA_MIN_CONFIDENCE` 0.8, OpenRouter's `state` array + `image_url` shape).
  Listed only for a desktop task the person started in the app with Jev ready.
  Jev is asked whenever there is at least one labelled control, even from a
  partial tree (the answer says "partial list"). A screenshot over the size
  limit is retaken at 512 px (`max_dimension`), else the answer is "none —
  screenshot too large for the vision fallback".
- **Fence review fixes.** OK/Continue/Save/Done ask once, and card only when
  the sheet or dialog holding them (AXSheet, AXDialog/AXSystemDialog subrole,
  or a window inside the top window) shows pay/sign/send/delete/notice words; Trash/Discard/Erase/Empty
  Trash count as delete; a click inside a consequential control (icon,
  caption, any containing frame) is that control's card under its real label,
  and an unnamed token is judged by its nearest named ancestor; a typed line
  break asks once (refused in a consequential field). The broker never starts
  a proxy after Stop or release and closes one whose session fails to start;
  page-tool updates without a title (Hermes `tool_call_update`) lose their
  content, output and screenshots before the native log; the mail screen's Jev
  usage lands on the loop run when no batch runs.
- **Mail loop.** Two narrow questions (`bulk` ≥ 0.97 and `asks_action` ≤ 0.03);
  known contacts and threads Bud or staff already touched are never screened;
  screened mail sits in a visible "Screened (n)" group with "Not noise" on the
  daily card and in the Mail view; an anonymised shadow log
  (`<DATA_DIR>/jev-screen-log.json`) collects tuning labels.
- **Per-run cost.** Every model and Jev/Luna call is attributed: Ask turns, job
  and loop runs (new loop-run cost route), batches (new batch cost route),
  recipe distill, ledger columns, bill ranking, portal control choice,
  readiness checks, refused Desk checks. "Computer-use decisions" shows as its
  own line.

## Open, in order

1. **Modelvia (owner):** merge and deploy the local `claude/gpt6-luna-route`
   branch in the Modelvia repo (Luna Decisions route + rate card r7 line
   "Computer-use decisions (GPT-6 Luna)"), date its review, add
   `gpt-6-luna-decisions` to allowed models, and raise `/v1/decisions`
   `MAX_STATE_BYTES` (256,000) and the 1 MB body cap for image routes. Until
   then RealBud refuses screenshots over ~180 KB and Luna answers "none".
   Update the subprocessors page: Luna is not zero-data-retention.
2. **Dev Modelvia key** (`REALBUD_EVAL_MODEL_KEY`) → `scripts/eval-jev.mjs --arm
   live`, run once with Jev and once with `REALBUD_JEV_MODEL=gpt-6-luna-decisions`
   on the text uses; change thresholds only from those reports.
3. **Full QA session** (below).

## QA session checklist

Run on an isolated data dir (CLAUDE.md lessons), macOS first, then the Windows VM.

1. cua 0.34 packaged: `/api/health`, driver version, contract 0.8.0 on Windows.
2. Live read-only REI read through Bud (work browser), no submits.
3. Desktop task on a harmless app (Calculator, TextEdit): picker lists it and
   hides browsers/terminals/RealBud; Start; Bud reads; `pick_control` listed;
   a "Delete"/"Send"-like control raises a card with the real label; Stop ends
   the session; phone cannot answer the card. Capture a real 0.34
   `get_window_state` and `list_windows` and replace the 0.22.1 fixture.
4. Mail: screened group visible, "Not noise" returns a thread; shadow log has no
   text.
5. Costs: a job run, a loop run and a batch show "AI: N requests", and
   "Computer-use decisions" when Jev ran.
6. Renderer QA scripts: `qa-morning-mail`, `qa-agency-mail`,
   `qa-kevin-sherry-day`, plus the usual sweep.
