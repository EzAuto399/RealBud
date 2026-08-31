# The law layer + intake completeness

Date: 2026-08-31
Status: design of record; both halves ship together. Canonical constraints:
`docs/GOAL-PROMPT.md` wins. The licensee boundary in `docs/PILOT-CONTRACT.md`
is untouched: statutory process stays with a licensed person, and nothing here
is legal advice.

Two additions, one goal: Bud should *know the territory* — Australian
residential tenancy — and should *know what a complete property looks like*.

## The honesty frame (read before the features)

- This is a **reference and a flag**, never legal advice and never a legal
  clock. Every law-flavoured answer ends with the verify line: confirm against
  the current Act or your licensee.
- Day counts on Desk stay **shop reminder rules** (the pilot contract's words).
  The law layer informs; it does not govern.
- No "law shelf" nav place, no legal product surface. The knowledge lives in
  the workroom and shows up in answers and quiet flags.

## 1. The knowledge layer

**Where it lives.** `server/law-reference.ts` holds the reference (typed,
tested, versioned with the app). `seedVault` copies it into the workroom as
`AU-RENTAL-LAW.md` — the worker's file toolset may read it (the skills toolset
stays forbidden; a vault doc needs no skill loader). `DESK-CONTEXT.md` carries
the book's jurisdictions so every answer lands in the right frame: a book in
ACT gets ACT rules cited, not a national blur.

**What it contains.** Per jurisdiction (ACT, NSW, VIC, QLD first; the rest
noted): rent-increase frequency and notice, arrears process thresholds
(remedy / leave / termination notice days), entry notice, bond caps, urgent
repair categories — each with its Act named and a verify note. Written as
shop-reminder reference, dated, with the sources named.

**What Bud does with it.**
- Asked ("can I increase rent twice this year?") → answers from the reference,
  in the book's jurisdiction frame, ending with the verify line.
- Proactive flag: when a Desk card or an Ask answer touches a known rule
  (a courtesy cadence pressing a statutory window, a second increase inside
  the year), Bud says so in plain language — "Heads up: ACT generally allows
  one increase in 12 months — check the current Act" — and never blocks.
- Never: statutory drafting, notice clocks, or advice presented as final.

## 2. Intake completeness — "what's missing to properly create this"

A property is properly created when its record is complete, not when its
address lands. The model (8 details):

1. Address · 2. Tenant name · 3. Tenant phone · 4. Weekly rent — the add form
   already requires these.
5. Owner contact (a contact with the owner role).
6. A current tenancy on the book.
7. Property code (the export identity the visit named).
8. Notes — the shop's memory the PMS doesn't keep.

**Where it shows.**
- Book card: a quiet line — "6 of 8 details — missing: owner contact,
  property code". Calm, never red; an incomplete record still works.
- Ask intake: after staging, the answer says what's missing — "Staged 4.
  To complete them: owner contacts and property codes — paste them and I'll
  fill them in."
- Import review: the same line under the matched count when matched rows
  would land incomplete.

**Computed, not stored.** `src/lib/completeness.ts` derives it from the
snapshot's own properties + tenancies + contacts — no server field, no
migration, no drift. Server-tested through the existing snapshot tests; the
helper carries its own unit tests.

## What this deliberately is not

- Not legal advice, not a legal clock, not a statutory drafter.
- Not a blocker: an incomplete property still evaluates, still gets cards.
- Not a new nav place, not a second brain UI.
- Not jurisdiction sprawl: the four named jurisdictions carry detail; the
  rest carry the national frame plus the verify line until a book names them.
