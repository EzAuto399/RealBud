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

The same objects appear through four doors only:

- **Desk**: queue, case, evidence, decisions and bounded handoff.
- **Ask**: case-scoped conversation, citations and proposed work.
- **Schedule**: named routines and the cases/drafts each run produced.
- **You**: agency, jurisdiction, sources and recovery; technical details under Advanced.

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

## Interaction rules

- No Send or Pay action exists.
- Allow approves wording or a bounded next step; it never submits externally.
- Browser work is tied to one case, published recipe, allowed origin and expiring lease.
- Default browser presentation is side-by-side. Per-session alternatives: inspector takeover or separate RealBud window.
- Idle browser space shows evidence/context, never a generic URL bar or playground.
- Handoff completion is auto-verified only by read-back evidence; otherwise the PM records "Done in PMS". Unknown stays unknown.
- Any destructive or irreversible action stays outside RealBud.

## Zero-terminal rule

The user interacts only with RealBud. RealBud takes their input and delivers it to the worker programmatically: installs run inside the app with streamed progress, model/provider setup is a form that writes worker config directly, updates are one click. Terminal never opens. The word Hermes never appears outside Advanced diagnostics.

## Onboarding rules

- The product opens working (demo book). Setup never blocks the window.
- One progressive Go-live checklist inside Desk/You; no wizard modals, no multi-step gates.
- Smart defaults: system timezone, inferred jurisdiction, AUD, shop-norm courtesy windows, detected Hermes install and provider auth.
- Permissions (TCC/Accessibility) are requested at first use of the feature that needs them, with a plain-language pre-prompt.
- Three coach marks maximum, ever. Success is announced; silence is a bug.

## Ask

- PM-first by default: case context, factual citations, proposed Desk work and per-turn approvals.
- Remove mascot dominance, reactions, branching, regeneration, agent mentions and generic code-tool chrome from the default surface.
- Advanced diagnostics may expose technical traces and provider health, but never extra agents, always-allow or arbitrary browsing.

## Responsive desktop

- `≥1280px`: queue + case + evidence/browser side-by-side.
- `960–1279px`: queue drawer + case + inspector rail.
- `<960px`: case canvas remains primary; queue and inspector are explicit drawers.
- Phone is Pocket later, not a squeezed desktop UI.

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
