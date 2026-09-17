# Product Marketing Context

**Document version:** v3
**Last updated:** 2026-09-17

> **Grounding note.** Every claim below is taken from the canonical docs in this
> repo — `docs/GOAL-PROMPT.md`, `docs/PM-COVERAGE.md`, `docs/PILOT-CONTRACT.md`,
> `pack/property/SOUL.md`, `DESIGN.md`, and the live site copy. Items marked
> **[confirm]** are my inference and need the founder's correction. Nothing here is
> invented; where the repo is silent, I say so.

## Product Overview

**One-liner:** The supervised desk for Australian residential property managers —
Bud does the routine work, you keep the decision.

**What it does:** RealBud sits on top of the PMS an office already runs. Bud checks
the book, gathers the evidence, and puts prepared work on a Desk for review —
draft wording, a morning exception list, a Friday owner update. The PM approves,
denies, or copies it into the system they already use. It never sends a notice,
never moves trust money, and never invents a legal clock.

**Product category:** The shelf customers search on is not "AI agent". It is
**property management software / property management admin tool** — specifically the
adjacent slot of *"something that takes the admin off my desk without replacing my
PMS"*.

**Product type:** macOS desktop application, local-first, with an invite-only billing
portal on the web. Not a SaaS web app. The work happens on the office Mac.

**Business model:** Invite-only paid pilots, then recurring. A fixed pilot fee agreed
by scope, then a monthly care fee plus metered AI at published GST-inclusive AUD
rates. Billing is separate from the desktop. No public self-serve signup.

**The consolidated positioning (agreed 2026-09-17):** RealBud is **the focused
agentic OS for the property-management office** — one office host, one Bud per seat,
arriving through the multi-instance work rather than through a broader vertical claim.

The distinction that matters: this is *not* a bid to be a general agent that happens
to know some property words. It is the opposite — narrow, fenced, and auditable. That
is the whole argument, and it is the argument a property manager actually cares
about:

> One office. Each seat its own Bud. Shared work where the office wants it, private
> memory everywhere else, and a receipt for everything.

Canonical framing (`docs/GOAL-PROMPT.md:13-15`):
> "a vertical Australian property-management desk. **Not a PMS. Not Hermes. Not an
> agent OS.**"
> "**Wall line:** The PM talks to RealBud. RealBud does the routine work. It only
> reaches someone else when asked — and never sends a notice or moves trust."

**Note on "Not an agent OS."** That line forbids selling RealBud as a generic agent
platform — an OS for arbitrary work. It does not forbid an OS *for this office*, which
is what the multi-seat work builds. Read it as "not a general agent OS", and keep the
scope sentence that follows it in the same section as the binding constraint:
*"If a change does not make the worker more PM and less general agent, it is out."*
(`GOAL-PROMPT.md:292`)

## Target Audience

**Target companies:** Australian residential property-management offices. Small
enough that one PM carries the full desk — the repo's working figure is ~170
properties per PM, about 2.8 minutes per property per day (`docs/PM-COVERAGE.md:9-11`).

**Decision-makers:**
- **User and champion:** the property manager (often the licensee or a senior PM at
  a first desk).
- **Financial buyer:** the billing owner — principal / licensee / office manager.
- Both may be the same person in a small office. **[confirm]**

**Primary use case:** the weekday the PMS does not run — exception judgement, draft
wording to copy, and the morning check, without changing the systems of record.

**Jobs to be done:**
- "Tell me who is late this morning and what you actually checked, so I can decide."
- "Prepare the owner update and the arrears wording so I only have to review it."
- "Work the way my office works — my rules, my sources, my PMS — and stop when you
  are unsure."

**Explicitly out of scope** (`docs/PM-COVERAGE.md:6`): *"Sales/leasing agents,
tenants, and DIY landlords are out."* Also out: sending, trust money, statutory
notices, and a tenant-facing bot (`docs/GOAL-PROMPT.md:19`).

## Personas

| Persona | Cares about | Challenge | Value we promise |
|---------|-------------|-----------|------------------|
| **Property manager** (user) | Getting through the day, not missing something that becomes a complaint | Interrupted constantly; the PMS holds the record but not the judgement | "I see what it used. It cannot send. It did not invent a clock." (`PM-COVERAGE.md:16`) |
| **Licensee / principal** (financial buyer) | Risk, compliance, staff retention | Can't delegate licensed judgement; can't audit what a tool did | Every run leaves a receipt; a licensed person still makes the licensed call |
| **First-desk / newly licensed PM** | Learning the job without dropping a file | Inherits the interrupt layer on day one | Named loops and a prepared Desk instead of a blank prompt box **[confirm]** |

## Problems & Pain Points

**Core problem:** the PM's day is interruption-shaped, and the systems they have
automate the *record* but not the *judgement*. The PMS already fires arrears
messages, vacate/renewal tasks and owner statements (`PM-COVERAGE.md:14`), so buying
"more automation" is not the gap. The gap is everything that needs reading, deciding
and wording between those events.

**Why alternatives fall short:**
- **The PMS** owns the record, the send and the trust — correctly — but cannot judge
  an exception or draft in the office's own words.
- **A general AI assistant** has no book, no rules and no fence, so it cannot be
  trusted with property data and cannot prove what it checked.
- **Doing nothing / spreadsheets** is what actually happens, and it is where things
  get missed.

**What it costs them:** hours per week on preparation, plus the risk that an
exception is noticed late — after it becomes a complaint or a breach.

**Emotional tension:** fear of missing something, and the specific fear of an
unregistered tool doing something consequential on the office's behalf.

## Competitive Landscape

**Direct:** PropertyMe, Property Tree, Reapit PM, Console Cloud — the PMS itself.
Falls short *for this job* because it is the system of record, not the assistant:
it has no reason to draft in the office's voice or to reason about an exception.

**Secondary:** general AI assistants (ChatGPT, Copilot) and PMS-native AI features
(e.g. vendor "AI" bolt-ons for bills or replies). These can draft but have no book,
no office rules, and no audit trail of what was read.

**Indirect:** hiring more admin staff, or the PM simply working longer.

**Adjacent, not competitive:** general agent tools — Codex, Claude Code, OpenCode and
similar. They are strong at owning a repository or a codebase and are deliberately
general. For property-management work they lack the book, the office rules, the clock,
the audit receipt and, most importantly, the fence. Do not feature-count against
them; position on focus. Claiming to be "better than Codex" at being Codex would be a
category error, and it would walk straight into the "Not an agent OS" line.

**The concrete version of that argument, and the one to actually use.** On
2026-09-17 the morning check was returning *"Worker answered 1 of 6 properties"* —
and the cause was not the model, the provider, or agent capability. The prompt asked
the worker for facts it had "actually observed" while naming **no book**: no file to
read and no id-to-address mapping. Meanwhile `DESK-CONTEXT.md` in the workroom already
tabulated all six properties with address, days since due, rent landed, levy and
courtesy. One prompt line fixed it.

That is the whole product in miniature. A general agent has no office book to be
pointed at — you would have to assemble the data, the rules, the clock and the
receipt yourself, and then keep them current. RealBud's advantage is not that its
model is smarter; it is that **the office's own context is already in the room, in a
form the worker is instructed to read and a PM can audit.** Lead with that, and never
with model superiority.

**Not a competitor to fight:** the PMS. The sales line is *"it works the system they
already have."* RealBud must never look like a replacement.

## Differentiation

**Key differentiators:**
- **It cannot send.** Send is a hard 403 (`server/index.ts`). Not a setting, not a
  prompt instruction — the route refuses. Verified live.
- **Draft only, then Copy.** The PM pastes into the PMS they already use.
- **Local-first.** The book lives on the office Mac (`~/.realbud/vault`); personal
  desk work, Ask, sources and schedules stay local.
- **Honest gaps.** Uncovered properties stay *held* with a reason ("Worker answered
  2 of 6 properties. Uncovered stay held.") rather than being papered over.
- **Says what it used.** Every run leaves a receipt, including which worker produced
  it.

**How we do it differently:** one pinned headless worker on one profile, named loops
on RealBud's own clock, and a fence around computer use (browser-typed, Allow-gated).
Not a prompt box, not a roster of agents.

**Why that's better:** it is auditable. A PM can answer "what did it read, and what
did it do?" without trusting a chat log.

**Why customers choose us:** because the promise is small enough to be true.

### The multi-instance argument (one office, many seats)

This is the differentiator that a single-user assistant cannot copy, and it is the
one to lead with once it ships. Every claim below is built and verified.

| | Reality |
|---|---|
| **One office host** | One owned PostgreSQL on the office network, provisioned by "Set up this office" with no terminal |
| **One Bud per seat** | `hermesProfileFor` gives each seat its own Hermes profile. A profile carries one memory, skills store and session database — so two seats on one profile are two writers on one state, which the code calls *"corruption, not cooperation"* (`hermes-profile.ts:15-18`) |
| **Per-seat provider and model** | The model *and* provider resolve from each profile's own `config.yaml` (`hermes-bridge.ts:441-444`). Two seats can genuinely run different providers, and changing one cannot disturb the other |
| **Shared where the office wants it** | `cases`, `knowledge`, `scopes`, `grants`, `workflow-template` and `work` cross seats, under an explicit sharing posture |
| **Private by default** | Personal Desk work, Ask, sources and schedules stay on that Mac. Isolation is the default, sharing is opt-in |
| **One clock, one house style** | Named loops run per office; a workpack/template means two PMs produce the same prepared shape instead of two dialects |
| **Auditable across seats** | Members, sessions and grants are separate; a receipt names which worker produced a run |

**Why this beats a general agent tool (including Codex) for this job — and where the
comparison is honestly a category error.** Codex is an excellent general coding agent
that owns a repository. RealBud owns an **office**: a book, a clock, a house style and
a licence boundary. Feature-counting one against the other is meaningless — what
matters is that for property-management work RealBud is *focused*, and focus is the
product:

- It has the book and the office rules; a general agent has neither.
- It **cannot** send, move trust or invent a legal clock; a general agent has no such
  fence, so it can do harm a PM cannot delegate.
- It runs named loops on the office's clock rather than waiting for a prompt.
- It leaves a receipt per run and holds what it could not verify, so a principal can
  audit the desk.

The performance story is therefore **team** performance, not model superiority: more
seats working the same week, with the same shared knowledge and house style, each with
private memory, and a principal who can see what happened. That is what "better team
performance" should mean in the copy — never "smarter than a general agent", which is
both unprovable and off-position.

**Constraint that must survive this framing:** "departments" mean *seats inside one
property-management office* (property management, accounts, the licensee), not new
verticals. Sales/leasing, tenants and DIY landlords remain out (see Anti-persona), and
the four windows Desk · Ask · Schedule · You do not gain a fifth.

## Objections

| Objection | Response |
|-----------|----------|
| "Is this just ChatGPT with a property skin?" | It has your book, your rules and a fence. It cannot send, and it shows what it checked. |
| "Will it replace our PMS / change our records?" | No. Drafts only, you Copy. Your PMS stays the record, the send and the trust. |
| "It's unregistered — can I let it near my files?" | It does not make licensed decisions. Statutory wording is not drafted; a licensed person decides. |
| "Another tool to learn." | One window, four places, and the work lands on a Desk for review — not a new system to administer. |

**Anti-persona:** sales and leasing agents, tenants and DIY landlords
(`PM-COVERAGE.md:6`); offices wanting the tool to auto-send to tenants; anyone
wanting an autonomous agent with no supervision.

## Switching Dynamics

**Push:** the interrupt load and the fear of a missed exception; preparation that eats
the week (`PM-COVERAGE.md:11` notes inspections alone take about a third of it).

**Pull:** a visible Desk with the morning's exceptions already checked, and wording
they can copy — plus a promise deliberately narrower than "AI does your job".

**Habit:** the PMS is comfortable and already automates the obvious parts; the
current workaround (spreadsheets, memory, working late) costs nothing to keep.

**Anxiety:** giving a tool access to real property data; the reputational risk if
something consequence-bearing is sent in the office's name. This is the anxiety the
wall line answers, and it should be led with, not buried.

## Customer Language

**How they describe the problem** — *verbatim customer quotes are not yet captured.
This is the biggest gap in this document and should be filled from the first pilot
conversations.* What the repo records as the office's own framing:
- "routine loops plus the odd interrupt" (`GOAL-PROMPT.md:29`)
- "the weekday the PMS does not run" (`PM-COVERAGE.md:16`)

**How they describe us:** not yet captured. **[confirm]**

**Words to use:** property manager, the office, your book, rent roll, arrears,
owner, draft, review, copy, quiet week, inspection, licence, licensee.

**Words to avoid:** agent (in Australia that reads as sales agent — say property
manager), landlord, tenant-facing, "AI agent OS", "autonomous", "replaces your PMS",
"send on your behalf".

**Glossary:**

| Term | Meaning |
|------|---------|
| **Desk** | Where prepared work and decisions land (Allow / Deny / Copy) |
| **Ask** | The one thread with the one worker |
| **Schedule** | Named loops on RealBud's clock |
| **You** | Name, hands, model, office setup |
| **Book** | The office's property records on this Mac |
| **Recheck** | The morning check against the book |
| **Held** | Work deliberately not advanced, with a reason |
| **Allow** | Approve wording or a bounded next step — never a send |
| **Care fee** | The recurring monthly service fee, GST-inclusive AUD |

## Brand Voice

**Tone:** calm, plain, unhurried. Plainly Australian, never matey.

**Style:** short declarative sentences. Says what it will not do as readily as what it
will. Concrete over clever — "it works the system you already have", not "AI-powered
workflow orchestration".

**Personality:** honest, steady, precise, modest, on your side.

## Proof Points

**Metrics:** none published. Do not invent them. The honest position is that the
product is pre-revenue with no agency results to cite. **[confirm]** whether any
pilot measurement exists.

**Customers:** none named. No testimonial exists and none should appear until a real
office gives one.

**Value themes:**

| Theme | Proof available today |
|-------|----------------------|
| It cannot send | Live: `POST /api/desk/drafts/:id/send` → 403 with "RealBud never sends. Approve the draft and send it from the PMS." |
| It admits what it missed | Live: "Worker answered 1 of 6 properties. Uncovered stay held."; a partial run is stamped `partial`, not `completed` |
| Runs on your Mac | Book and desk data live under `~/.realbud`; the site states it is "not an always-on cloud service" |
| Works with your PMS | Site FAQ: "RealBud works alongside your existing systems" |
| Billing is GST-inclusive AUD | Published rates and invoices are GST-inc AUD; wholesale and margin are never shown |

## Goals

**Business goal:** a named, paying Australian residential property-management office
using RealBud on a weekday — the gate the repo calls *"the only thing that makes
morning money real… Human."* (`PM-COVERAGE.md:80`)

**Conversion action:** the enquiry form on `realbud.app` — "Find your first job" →
`#pilot`. Enquiries are stored privately with no auto-reply.

**Current metrics:** none instrumented in the repo. **[confirm]** what to measure;
the natural first pair is enquiry → workflow review, and review → signed pilot.

## Changelog
*Newest first. One line per revision: what changed and why.*
- v3 (2026-09-17) — Added the concrete Codex differentiator to Competitive Landscape:
  the one-of-six morning check was a missing book pointer, not a weak model, which is
  the product's focus argument in miniature.
- v2 (2026-09-17) — Consolidated the positioning as "the focused agentic OS for the
  property-management office" and added The multi-instance argument (one office, many
  seats), with an explicit reading of "Not an agent OS" as forbidding a *general*
  agent OS rather than an office one. Added the Codex comparison and why it is a
  category error, and restated that "departments" means seats inside one PM office,
  not new verticals.
- v1 (2026-09-17) — Initial context, drafted from the canonical repo docs rather
  than interviews. Personas, customer language, proof metrics and the conversion
  target are marked **[confirm]** because the repo does not contain them.
