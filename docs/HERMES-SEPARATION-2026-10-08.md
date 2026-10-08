# Hermes separation — 8 October 2026

Owner direction (8 Oct): RealBud is a harness on top of the Hermes harness. It uses the worker only through supported interfaces, owns every RealBud fact outside worker storage, and loses nothing when the worker folder is deleted or replaced.

Branch `claude/hermes-separation`, intended for **0.1.43**, after the Auston showcase install of 0.1.42. It is not merged or released.

## What changed

| Area | Now |
|---|---|
| Bud's memory, learning, office edits | Canonical copy in `~/.realbud/worker-state/<workspace>/<scope>/state.json`. The worker profile is a projection of it. Worker-side edits never become canonical: memory edits become reviewable proposals, and skill and SOUL edits are held for review. Shared caps keep only a digest past them. Credential-shaped bytes are kept as a digest only. |
| Memory review | RealBud-owned operations (`server/hermes-memory-owned.ts`, `hermes-memory-store.ts`), using the same signed receipt and journal formats as the old Python helper. Memory-signing keys travel in encrypted backups. Helper-era proposal identities are aliased at import. |
| Backups | Capture, validate and restore canonical facts and learning ledgers. Withheld items are counted in the receipt. Credentials are excluded. |
| Model choice | Canonical in `D/worker-control/` and restored when a profile is recreated. Department preparation uses it. |
| Runtime | The selection and receipts live in `D/worker-control/`, and a corrupt file holds launches instead of throwing. Readiness binds to `verifyRuntime()` integrity. A check that can't run is "unavailable", never "damaged". |
| Removal | `POST /api/hermes/uninstall` records a removal that completes only after a verified reboot. `/uninstall/cancel` withdraws it. Both are admin-gated. Profiles are kept. |
| Department preparation | A RealBud-owned bounded model loop. The worker-internal Python helper is deleted. |
| Document tools | Libraries go only into an intact catalog runtime. Legacy, unknown or replaced runtimes get "update Bud" and nothing is written. An owned Word/Excel/PDF stack is **not** built: RealBud has no Node writers, so it would need its own Python runtime. |
| ACP skills cache | Removal is gated on reviewed releases. Unknown layouts are refused. |
| Errors | Chat persists only product sentences, never worker paths. `EngineSetup` points to Bud setup. |
| Repair | Every SOUL reset (Repair, Install, apply-pack, automatic repair) first copies an office SOUL edit RealBud couldn't keep into `worker-state/.../kept/`. It never renames inside the worker folder. |
| Launch | A turn refuses while memory RealBud hasn't approved would reach the worker, or while the profile folder is a link. |

## Evidence (source + local tests; no packaged or installed run yet)
- Full `vitest run` on this branch before the final review round: 639 files / 10,250 tests passed (322 environment-gated skips are not passes). Final run: see `outputs/hermes-separation-2026-10-08/vitest-full-5.log`.
- Independent review (Codex gpt-6-astra, ultra) took seven rounds: 2 High plus 5 Medium, then 2 High plus 3 Medium, then 1 High each round after that. Automated security reviews flagged 12 more. All were fixed. Final verdict at `09394fe5`: **safe to ship as 0.1.43: yes** (static review).

## Behaviour changes for offices
- Hand edits to SOUL or skills made inside the worker folder are held for review, not adopted, and **there is no review screen yet**. Edits should go through RealBud.
- A broken worker config no longer stops memory review; the pack policy applies instead.
- A pack proposal approved twice returns the saved result. A contrary decision gets 409.
- Department preparation uses RealBud's prompt, not the upstream planner's.
- The readiness fingerprint now includes the runtime on disk, so existing passes go stale once after upgrade. Linked offices re-check automatically.

## Required before release (packaged builds)
1. Upgrade an isolated 0.1.42 office with memory, pending reviews, an edited SOUL and an interrupted pack upgrade. Then run Repair, worker deletion, crash and restart, and regeneration, and compare the exact retained bytes and decisions.
2. Back up straight after the upgrade, then restore into a different installation key: decisions, history, pending, undo and legacy retries must all verify. Loose private files must still be refused.
3. Runtime: healthy and damaged replacements, recovery from a transient custody refusal, removal refused before a reboot and completed after a real one, and the department model and effort unchanged.
4. Repeat 1–3 on the Windows VM. The memory-review platform hold there must be preserved.

## Open
- A review screen for held SOUL/skill edits and `kept/` copies.
- An owned document toolchain, which needs a decision on shipping a Python runtime.
- Windows skills-cache guard (macOS sandbox only today).
