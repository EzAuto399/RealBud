# Team decision

**Ruling (2026-09-17, owner decision): the office-of-one is the product. Joining a
team is an add-on an office buys, never a mode RealBud requires.**

**Implementation clarification (2026-09-20):** this is product direction, not a
release-readiness receipt. The [solo/local-office review](SOLO-AND-LOCAL-OFFICE-REVIEW-2026-09-20.md)
records the original gaps and detailed journeys. The [implementation follow-up](PRODUCTION-LIFECYCLE-IMPLEMENTATION-2026-09-20.md) adds stable private Bud continuity, guarded leave/disconnect, ownership transfer and encrypted host recovery. Device enrollment and installed-device acceptance remain incomplete.

This document exists because "team" kept moving. It was five different features
wearing one word, and one of them quietly contradicted the wall line. Separating
them is the whole point.

## The five meanings, separated

| Meaning | What it actually is | Verdict | Why |
|---|---|---|---|
| **Shared billing** | Several seats, one payer | **IN — already works** | `billing_accounts` holds one company with many principals. No shared data, no server. |
| **Shared book** | Two PMs, the same properties | **IN — future scope requires a separate contract** | Current books stay local. Joining currently shares reviewed work and templates; it does not implement a shared book. |
| **Case handoff** | "I'm away, you take this" | **IN — behind joining** | Reviewed artifacts, acceptance and revision guards exist in `server/company/work-items.ts`. This does not prove shared worker execution or installed-device operation. |
| **See each other's work** | Visibility, oversight | **PARTIAL — reviewed artifacts only** | `company-host.ts` already limits the shared layer to "explicitly reviewed shared work and company templates." Ambient visibility is refused. |
| **Approval chains** | Principal signs an associate's draft | **OUT** | This is the one that breaks the wall line. See below. |

## Why approval chains are out

The wall line is verbatim: *"The PM talks to RealBud. RealBud does the routine
work. It only reaches someone else when asked — and never sends a notice or
moves trust."*

An approval chain means Bud escalates to a second person **because a policy says
so, not because the PM asked**. That is reaching someone else without being
asked, and it makes RealBud the thing that moves trust between people. It is the
same failure as auto-sending a notice, one step removed.

A principal *may* still review an associate's draft — but as a **seat** doing
their own work in their own window, or as a human passing a draft across the
desk the way they do today. RealBud does not become the approval authority.

## The line that makes the rest coherent

> **Seats share work artifacts. Seats never share memory.**

- `Ask` threads, sources, schedules, and the book stay local to a seat. Two Buds
  in one office do **not** pool context and do not learn from each other.
- A **case** is the only thing that crosses. It crosses because a person claimed
  it — a deliberate, visible handoff, not ambient awareness.
- This is why "one Bud per seat" survives contact with teams: a Bud is not a
  shared brain that gets bigger, it is a set of hands that can accept a task.

Each private workspace retains its own existing worker profile through an immutable workspace manifest. Legacy `property-<memberId>` profiles remain where they are; solo joining keeps its existing `property` profile. Membership changes never merge profiles, memories or credentials.

## What each deployment looks like

```
OFFICE OF ONE  (default, shippable, no server)
   Mac ─ seat 1 ─ Bud(property-1) ─ encrypted book (AES-256-GCM, Keychain key)
   website: billing + org key + one pr_… per office

OFFICE OF MANY  (add-on, requires a shared Postgres)
   Mac A ─ seat 1 ─ Bud(property-1) ─ local book ─┐
   Mac B ─ seat 2 ─ Bud(property-2) ─ local book ─┼─ cases / claims / templates
   Mac C ─ seat 3 ─ Bud(property-3) ─ local book ─┘   (shared, reviewed only)

   shared layer:  cases ❘ claims ❘ templates ❘ membership ❘ host certificate
   NEVER shared:  books, Ask threads, sources, schedules, tenant data,
                  the client's ak_ key, per-seat worker memory
```

Joining is **explicit, host-certificate-pinned and member-authenticated**.
Per-device enrollment and revocation remain an admission gate. There is no
ambient discovery, and an office that never hosts collaboration needs no company database.

## Why this ordering

1. **It is the existing constitution.** "One Bud per seat" and no cross-seat
   memory already say coordination is the exception. Making it the foundation
   would invert the design to serve the minority case.
2. **It should be reversible.** Local continuity, leave and explicit disconnect now have implementation and local tests. Copies already shared cannot be recalled. Installed-device acceptance remains a release gate.
3. **It keeps the pilot cheap.** The office-of-one needs no shared database or
   collaboration network service. Its private data still needs recovery and backup.
   A shared host adds database operation and backup responsibilities.
4. **It matches the audience rule.** Residential PM offices of 1–3 people are
   the target. The shared layer is for the 5+ PM office, which is a later sale.

## What this does not decide

- **Other hosting options** beyond one existing office computer. The current
  local host implementation uses an owned Postgres on that computer; it does not
  require a third computer. NAS/hosted alternatives need separate admission.
- **Whether joining is billed separately** from seats.
- **Migration**: an office-of-one that later joins has a local book and a shared
  layer. Which properties become shared cases is a per-office decision, not an
  automatic sync. Not designed yet.
- **Windows and installed-device acceptance**, still pending per
  `company-host.ts` LIMITATIONS.

## Consequences for current work

- `docs/OFFICE-LIFECYCLE.md` provisioning stays **one Composio project per
  office**, independent of seats. Seats share the office's project; they do not
  each get one.
- The end-of-life path is per **office**, not per seat, because revocation is per
  project. Losing one seat is a membership change, not an offboarding.
- Nothing in the shared layer may become load-bearing for the private workspace.
  Collaboration itself requires joining; independent local work must not.
