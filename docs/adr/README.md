# RealBud architecture decisions

`docs/GOAL-PROMPT.md` remains the canonical product contract and wins every
conflict. These records explain implementation choices underneath that
contract; they cannot weaken a hard gate.

| ADR | Status | Decision | Revisit |
|---|---|---|---|
| [0001](./0001-realbud-owned-work-routing.md) | Accepted | RealBud-owned local-first work routing around an external pinned Bud runtime | Named pilot evidence or 2026-11-27 |
| [0002](./0002-bounded-inbound-interrupt-pipeline.md) | Accepted | Digest-addressed, source-safe inbound cases and supervised follow-up; live mailbox remains pilot-gated | Named mailbox and PM workflow evidence |
| [0003](./0003-governed-extension-foundations.md) | Accepted | Code-owned adapter manifests and fresh attestations for named connectors, isolated work, cloud and History without a generic tool marketplace | First live adapter/provider/stable History pin or 2026-11-27 |
