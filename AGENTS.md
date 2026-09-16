# RealBud development

RealBud is the product; Bud is its assistant. This checkout is named PropertyMe for historical reasons. Do not ship under the PropertyMe, Hermes, OpenMausBot or OpenManus names. Private application data belongs under `~/.realbud`.

## Product boundaries

- RealBud owns the window, job authority, approvals, receipts, recovery and clock. The agency's PMS, bank, mail and files remain authoritative for their business records. Bud retains source references and work state; do not introduce a second manually maintained rent roll.
- Keep one Bud identity and a headless Hermes worker behind the supported adapter/profile. No Hermes.app, extra product agent roster, tenant-facing bot or separate Hermes scheduler. Coding assistants used to develop RealBud are distinct from product agents.
- Preserve no-send, no-trust, no-statutory-draft and no-invented-legal-clock boundaries. Do not add a law crawler. Locked `never` rules remain locked.
- Attended portal jobs require the existing Attach/job fence. Humans sign in. Bud may read or prefill only within the saved scope; Submit requires the exact job's permission and a per-instance decision. Pay, sign, notice and send remain outside that Submit permission.
- Preserve existing records and training fixtures through migration. Sample-book or fallback results must remain visibly distinct from live office results. New inbound/graduate workflows must satisfy the office-setup and delivery gates recorded in the relevant plan.

## Read for the task

- Product direction or milestone selection: `docs/GOAL-PROMPT.md`, then the relevant part of `docs/NEXT-WAVE.md` or `TODOS.md`. Historical shipped-state bullets are not current implementation proof.
- Computer work and durable jobs: `docs/REALBUD-COMPUTER-WORK-ARCHITECTURE-2026-09-12.md`; portal scope: `docs/PORTAL-WORK.md`, `server/portal-fence.ts`.
- UI: `DESIGN.md`, `docs/PRODUCT-DESIGN-PLAN.md`; routines and clock: `docs/ROUTINES.md`, `server/routines.ts`; PM workflows: `docs/PM-DAY.md`.
- Identity/profile: `docs/IDENTITY.md`, `pack/property/`, `server/hermes-pack.ts`; worker lifecycle: `docs/WORKER-LIFECYCLE.md`.
- Local QA: `docs/QA-LIVE-DEBUG.md` and `package.json`. Start with affected Vitest files or `pnpm typecheck`; use `pnpm qa` for the integrated local gate when warranted. `qa:live-worker`, packaging and installed-device checks have different effects and proof levels.

## Hermes integration

- Hermes is an unmodified upstream dependency. Do not patch or vendor its source, monkey-patch Python, or rewrite a user's separate checkout or launcher. Put RealBud behavior in adapters, job controllers, tools, profile and skills. Preserve native memory and skills across updates; keep credentials and operator data outside versioned runtime directories.
- Resolve the supported release from `server/hermes-pin.ts` and the runtime manager. Use verified official commits and installer hashes, fresh candidates, bounded cancellation, a shared setup lock and atomic selection for the next launch. Preserve the previous runtime; never track upstream main automatically.
- Release promotion requires real ACP/model/file/recovery and configured-versus-explicit MCP isolation checks. Upstream release metadata alone does not authorize installation. See `docs/REALBUD-HERMES-UPSTREAM-2026-09-12.md`.
- Worker execution requires upstream-supported `HERMES_SAFE_MODE=1`: configured MCP/plugins/hooks/webhooks do not auto-run, while native memory/skills and explicitly mounted ACP tools remain usable. Recheck this contract for a new release.
- Upstream ideas may improve the harness and safety; they do not authorize extra engines, teams, plugins or a model shop. Keep RealBud's clock and current `cron_mode: deny` boundary.


<!-- OPENWIKI:START -->

## OpenWiki

This repository has a generated `openwiki/` evidence index. It is optional just-in-time context, not required startup reading.

- Treat source code and tests as authoritative. A brief's unknowns and review items are verification gaps, not automatic requirements.
- Prefer the narrowest quiet validation that proves the changed behavior. Preserve complete failure output.

The scheduled OpenWiki GitHub Actions workflow refreshes the repository wiki. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.

<!-- OPENWIKI:END -->
