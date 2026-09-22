---
paths:
  - "src/**"
---

# src/ (renderer) conventions

- All server traffic goes through `api()` in `src/state/store.tsx` (session + admin headers, `.status`/`.code` on errors, one re-handshake on a 401). Never call `fetch` directly. Feature APIs are factories taking an injected `request` (`src/lib/company-api.ts`) so tests never touch the network. Member session tokens live in tab `sessionStorage`, never in URLs or `localStorage`.
- Re-validate every server field before it enters state; a malformed 200 is an error. A transport failure may hide a committed write: classify it as uncertain, never as failed. Conflicts keep the operator's draft and surface as "This card changed — open it again"; a late snapshot must not regress a run from settled to active (`src/lib/schedule-state.ts`). Facts older than 12 h read as stale.
- The reducer is pure; async lives in the memoised dispatch or the single SSE fold. Streaming tokens use `StreamContext`, not the reducer.
- Four doors only: `DeskView` in `src/lib/app-route.ts` plus `VIEW_ACTIONS satisfies Record<DeskView, …>` in `src/App.tsx` is the compile-time gate. Every screen is a `lazy()` chunk and Desk must not pull the You/Schedule/Setup/Onboarding chunks (`scripts/qa-screen-loading.mjs` enforces it).
- Design (`DESIGN.md`): colours only from the `@theme` tokens in `src/styles.css`, no raw hex; 44 px `.pm-control`/`.pm-decision` targets; `Card`/`CommandLine` from `SettingsPrimitives.tsx` instead of new bordered panels; breakpoints at 1279/959/719 px in CSS, not JS; `html`/`body` are `overflow: clip`, so every screen owns its own `min-h-0 overflow-y-auto` region; motion is transform/opacity with a `motion-reduce` fallback.
- Accessible names are load-bearing: QA locates controls by role and name. Nav items carry `aria-label`, `aria-current="page"` and the focus ring (`Sidebar.tsx` `item()`).
- Copy: `src/lib/workspace-copy.test.ts` forbids "Hermes", "MCP", "broker", "RealBud clock" and "You →" on primary surfaces; route upstream vocabulary through `budFacingCopy` (`src/lib/bud-setup.ts`); engine names belong only in Advanced diagnostics. A book reads "Sample book" unless live and non-demo. Setup completion never claims workflow readiness. Absent evidence is never evidence (`shared/pm-evidence-rules.ts`). Never present a fallback timezone, fixture or unverified schedule as real configuration.
- Component tests render with `renderToStaticMarkup` in the node environment (no jsdom) with `vi.mock('@/state/store')` and assert on HTML including `aria-label`. Visual proof is a `scripts/qa-*.mjs` run that renders real components against a real store or server, writes screenshots plus `receipt.json` to `outputs/<topic>-<date>/`, asserts zero renderer `pageerror`, and checks 390×844 with no horizontal scroll. Screenshots are fictional examples, never customer acceptance.
