---
paths:
  - "docs/**"
---

# docs/ conventions

- Dated receipts are `docs/TOPIC-YYYY-MM-DD.md` and open with what the checkpoint does not establish. Durable decisions are `docs/decisions/YYYY-MM-DD-topic.md`. Superseded documents move to `docs/history/` under their own date and are marked non-overriding. `docs/acceptance/*.json` are versioned machine contracts read by gate scripts, not prose.
- Current entry points: `docs/GOAL-PROMPT.md` → `docs/decisions/2026-09-21-business-os-and-austin-workflows.md` → `docs/END-STATE.md` → `docs/REAL-ESTATE-CORE-2026-09-21.md`. `NEXT-WAVE.md`, `PM-DAY.md` and the PM-only history are dated references, not scope.
- A new checkpoint is linked by prepending a `Latest continuation:` (or `Latest product continuation:`) paragraph and demoting the previous one to `Previous continuation:`; superseded sections stay in place under a header note rather than being deleted.
- Evidence tiers are named and never conflated: source → local tests → packaged build → installed device → live integration → customer acceptance. Test results are exact triples (passed / failed / environment-gated skipped) with the artifact path under `outputs/`; a timed-out or partial review is never approval; fixtures, fictional providers and unsigned packages are never customer proof.
