# RealBud Design System

Status: approved direction, 2026-08-24. Implementation source of truth for the native PM redesign.

Canonical product constraints remain in `docs/GOAL-PROMPT.md` and win conflicts.

## Design intent

RealBud should feel like a trusted Australian property-management office ledger with one supervised worker inside it. It must not look like Hermes Desktop, Grok, ChatGPT, a bot roster, or an AI dashboard.

The visual model is **Warm Operational Ledger**:

- Calm, dense, evidence-first desktop software.
- Human office cues through warm paper and ink, not decorative nostalgia.
- Property, tenancy, case, source and decision are more prominent than Bud.
- Safety appears in action structure and state, not repeated marketing copy.
- Bud is contextual assistance attached to a case; it is never the product shell.

## Product spine

```text
portfolio queue → property / tenancy / case → evidence → human decision → bounded handoff
```

The same objects appear through four desktop doors only:

- **Desk**: queue, case, evidence, decisions and bounded handoff.
- **Ask**: case-scoped conversation, citations and proposed work.
- **Schedule**: named routines and the cases/drafts each run produced.
- **You**: agency, jurisdiction, sources and recovery; technical details under Advanced.

Schedule renders routine dependencies as compact text-plus-state chips and a run as one expandable receipt, not nested automation cards. You begins with a compact in-page Agency / Worker / Connections / Recovery status navigator so a long setup page remains usable at the supported 900 px window. Its approved-capability search and category filters are presentation over a small closed catalog; they never discover, install or grant a tool. Each result remains one flat verified row, its real action routes to the existing Desk or app-owned setup owner, and implementation methods such as Direct API, restricted Composio or approved MCP stay collapsed under **Advanced** and never look connected until RealBud-owned state says so.

The closed catalog also contains one collapsed **Advanced work methods** row. It shows the difference between a built admission foundation and a fresh live adapter for named APIs, restricted connectors, isolated tasks, cloud lanes and Computer History recovery. It has no Add, URL, key, command or provider-discovery controls. Foundation status is neutral; only a current app-owned runtime receipt may use the green Ready state.

You's General control centre also shows one app-owned **Local work routing** row. It names Local standard/accelerated/cloud acceleration, the current one-batch portfolio shape, resource or capability fallback and a measured-or-unavailable estimate. It is status and navigation only: it cannot grant a lane, choose a personal browser, enable cloud spend or weaken manual Allow.

**Pocket is a transport, not a fifth door.** One named PM's private mobile chat projects into the canonical Ask thread. It may show the same server-authored review card and manual Allow/Not now decision, but it never owns state, tools, a second conversation, or a compressed copy of the desktop UI.

## Colour

| Token | Value | Use |
|---|---|---|
| `paper` | `#F3EFE5` | App background |
| `sheet` | `#FFFBF2` | Case canvas and focused work |
| `ink` | `#25231F` | Primary text |
| `ink-muted` | `#6F695E` | Secondary text |
| `line` | `#D4CCBB` | Dividers and structure |
| `agency` | `#3F5F45` | Primary actions and current source |
| `agency-hover` | `#314B36` | Primary hover |
| `selected` | `#DDE4D2` | Selected queue/case state |
| `hold` | `#B27A24` | Held or needs verification |
| `danger` | `#A64632` | Failure or blocked safety state |
| `portal` | `#315F91` | Active bounded browser session |

No gradients, glow, neon accents, translucent glass panels, or dark card soup. A dark mode may come later; it is not part of this implementation.

## Typography

- Native system sans: `-apple-system`, `BlinkMacSystemFont`, `Segoe UI`, `sans-serif`.
- Tabular numerals for rent, dates, days late and evidence timestamps.
- Operational body text: 14–15px minimum.
- Case title: 22–24px semibold.
- Screen title: 26–28px semibold.
- Labels: 12px, sentence case by default. Uppercase is reserved for short evidence/status labels.
- Technical identifiers use system monospace only inside Advanced diagnostics.

## Shape and spacing

- Radius: 4px controls, 8px panels. Pills only for binary status.
- Structure comes from split panes and dividers, not nested cards.
- Control height: 40px minimum; primary decision actions 44px.
- Spacing scale: 4, 8, 12, 16, 24, 32.
- Shadows only for modal elevation, drawers and detached browser windows.

## Core components

- `SplitView`
- `CaseQueueRow`
- `CaseHeader`
- `FactSummary`
- `SafeguardStatus`
- `EvidenceRail`
- `DecisionBar`
- `HandoffPanel`
- `SourceStamp`
- `RecoveryNotice`
- `AdvancedDiagnostics`

Every component has loading, empty, partial, success, failure, stale and recovery behaviour where relevant.

On Desk, the queue is a scanning surface: every filter carries its current case count, search is address/person first and the selected row uses text plus selection semantics. A clean repeated case leads with what is unchanged, one compact clear-safeguards result and the proposed decision; exact wording and prior context remain one click away. Active safeguards, changed evidence and first reviews stay expanded. The evidence rail names source freshness and why the case exists without repeating technical identifiers. The decision bar keeps the exact-version/no-send boundary beside Allow at every supported width.

## Interaction rules

- No Send or Pay action exists.
- Allow approves wording or a bounded next step; it never submits externally.
- Browser work is tied to one case, published recipe, allowed origin and expiring lease.
- Default browser presentation is side-by-side. Per-session alternatives: inspector takeover or separate RealBud window.
- Idle browser space shows evidence/context, never a generic URL bar or playground.
- Handoff completion is auto-verified only by read-back evidence; otherwise the PM records "Done in PMS". Unknown stays unknown.
- Any destructive or irreversible action stays outside RealBud.
- A mobile Allow is the same revision-checked action decision as desktop Allow. The channel cannot invent a new operation, bypass a stale card, or gain terminal/browser authority.

## Zero-terminal rule

The user interacts only with RealBud. RealBud is the control plane, not a transparent skin: Desk/Ask/Schedule/You and the Pocket transport enter the same RealBud-owned identity, capability, approval, persistence and receipt boundaries before Bud receives a bounded turn. The worker supplies reasoning and tool execution; it never owns product state, schedules, channel authority or updates.

Installs run inside the app with streamed progress, model/provider setup is a form that writes worker config directly, and updates are one click. One exclusive server lease serializes Ask/Pocket turns, live Desk checks, scheduled hands, model/pack changes, diagnostics and update preflight, so the single worker cannot execute against configuration that is being replaced. A worker update builds in the inactive stable A/B slot, verifies the exact app pin, atomically switches RealBud's active link, retains one prior runtime and rolls back on a failed activation probe. A crash can restore only that known prior runtime or isolate an unverified first install; it never silently downloads a newer engine, trusts a partial install, resets the property profile or touches personal Hermes state. Terminal never opens. The word Hermes never appears outside Advanced diagnostics.

## Onboarding rules

- The product opens working (demo book). Setup never blocks the window.
- First run uses one focused, window-owning decision at a time: Prepare Bud, connect a model securely, then bring in the portfolio. Operational navigation and the You control centre are not visible behind it. Each screen has one primary action, one short reassurance and a three-segment progress line. **Use the practice desk first** is always available, and You reopens the same journey. The current screen comes from live worker/book/recovery truth; local preference can reopen the guide but cannot grant readiness. Recovery replaces setup progress with the protected-state owner and exact book-key repair; it never reveals the agency, routing, connections or pilot dashboard. Prepare Bud owns private runtime plus safety-pack preparation behind one deliberate action; setup errors stay plain while internal install/pack/test controls remain under You's technical repair details. Agency details, private computer use, recovery-key reveal, reminders and pilot connections stay out of first run and remain in You.
- Smart defaults: system timezone, inferred jurisdiction, AUD, shop-norm courtesy windows, detected Hermes install and provider auth.
- Permissions (TCC/Accessibility) are only requested after the PM chooses the feature's Set up action, with a plain-language pre-prompt. Merely viewing the first Desk guide never prompts or grants.
- Three coach marks maximum, ever. Success is announced; silence is a bug.

## Ask

- Universal intent, bounded action: the PM may describe any safe job in ordinary language. Bud shows the useful outcome and current capability state; only a server-authored, reviewable RealBud operation may change state or start a handoff.
- PM-first by default: case context, factual citations, proposed Desk work and per-turn approvals.
- Bud's prose renders as one calm document block with real Markdown hierarchy, readable lists/tables and a restrained response footer. Raw provider tool names never appear in the default transcript.
- Tool activity is translated through a closed RealBud presentation map. Unknown tools degrade to a generic non-authoritative check; connection success is shown only from app-owned status, never model prose.
- “Suggested next” is derived from current Desk/Schedule state and can only navigate to the owning surface or start an ordinary Ask turn. A suggestion never executes work.
- Remove mascot dominance, reactions, branching, regeneration, agent mentions and generic code-tool chrome from the default surface.
- Advanced diagnostics may expose technical traces and provider health, but never extra agents, always-allow or arbitrary browsing.

## Responsive desktop

- `≥1280px`: queue + case + evidence/browser side-by-side.
- `960–1279px`: queue drawer + case + inspector rail.
- `<960px`: case canvas remains primary; queue and inspector are explicit drawers.
- Phone is the dedicated, pilot-gated Pocket projection of Ask, not a squeezed desktop UI. The desktop remains the complete review/evidence surface.

## Accessibility

- `aria-current` on navigation; real dialog semantics and focus traps.
- Visible focus on every interactive element.
- Text plus icon for all states; colour is never the sole signal.
- Full keyboard pane switching and focus restoration.
- Reduced-motion support covers spinners, pulses and custom animation.
- Copy/save/import actions announce success through a polite live region.

## Hard rejections

- No “Grok Bot” palette or upstream product naming.
- No generic agent dashboard, model picker, bot settings, teams or computer playground.
- No nested rounded-card grids as the primary layout.
- No tiny operational text or icon-only core actions.
- No technical terms such as pin, pack, headless, recipe or revision outside Advanced diagnostics.
