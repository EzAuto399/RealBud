# ADR 0002 — Bounded inbound interrupt pipeline

- Status: Accepted
- Date: 2026-08-27
- Owners: Desk V3, inbound classifier, Desk queue
- Revisit: after `docs/PILOT-CONTRACT.md` names the office, mailbox, read scope and PM

## Context

Unplanned tenant, owner, tradie and prospective-owner messages destroy a PM's week. RealBud needs to reduce that interruption load without turning a mailbox, message body or model into execution authority. A live mailbox is not yet named, and the hard gates still forbid sending, statutory drafting, trust work, invented legal clocks and generic tool access.

## Decision

Ship the source-safe interrupt foundation against a fixed, labelled Demo inbox. Keep the live mailbox adapter, polling routine and OAuth flow pilot-gated.

```text
bounded read-only envelope
  -> strict size/time/identity validation
  -> deterministic category + exact property match
  -> digest-only message/thread identity
  -> encrypted immutable Evidence
  -> one open Desk case per thread
  -> optional operational reply draft
  -> PM Allow exact wording
  -> PM sends in mailbox/PMS
  -> PM attests "sent externally"
  -> Waiting with a shop follow-up date
  -> PM closes when resolved
```

The current product route is `POST /api/desk/inbound/demo`. It accepts only the current Desk revision; the server supplies the fixed sample batch. It is not a general message-ingestion API and cannot connect to a provider.

## Contract and ownership

- Raw provider ids become SHA-256 message and thread keys before persistence.
- Raw message bodies, attachment bytes and attachment names never enter the Desk book. The encrypted book stores a bounded, category-derived summary, sender/address, subject, timestamps, counts and safety flags.
- Each unique message produces one immutable `mail` Evidence row. Replaying the same message key is a no-op and does not bump the Desk revision.
- New messages on an open thread update one case and one current proposal. A decided or waiting thread can reopen with a new exact proposal while old revisions and Decisions remain immutable.
- Maintenance, tradie, owner, payment and BDM acknowledgement drafts are operational only. They cannot accept a quote, dispatch a contractor, confirm payment allocation, provide an appraisal, quote fees or create an agreement.
- Statutory/legal language, secret-like instructions, do-not-contact safeguards and ambiguous property/thread matches create held cases without wording.
- `Allow` still records only the exact proposal revision. `/api/desk/drafts/:id/send` remains 403. Waiting requires a separate human attestation after the PM sends outside RealBud.
- The two-day Waiting follow-up is explicitly a shop reminder, never a statutory or legal deadline.

## State and recovery

`approved -> waiting -> confirmed` is the admitted follow-up path. A new inbound message may reopen Waiting as `proposed`; automatic send, automatic close and automatic statutory escalation do not exist.

Inbound Evidence, case context and proposal are written through the existing encrypted V3 atomic commit. A proven pre-replace failure restores the prior book and is retry-safe. A landed-but-unconfirmed write enters the existing read-only recovery mode. Message digests and thread keys prevent duplicate cards after restart; the V2 compatibility projection carries the bounded inbound context but excludes mail Evidence from money observations.

## Security and privacy

- Message text is untrusted data, never a prompt, command, URL, credential, capability or tool grant.
- Attachments remain unopened in this slice.
- Classification is deterministic and model-independent.
- No provider call, OAuth flow, mailbox mutation, calendar write, contractor dispatch or background poll is added.
- BDM stays a category of inbound triage, not a new agent, surface or workflow engine.
- Hermes remains an immutable pinned dependency and is not edited or given mailbox/browser/terminal authority by this decision.

## Live-adapter gate

A live route may be designed only after the pilot contract names the agency, PM, mailbox/provider, exact read scope, retention, disconnect behavior and success/recovery evidence. It must add provider-side claim/deduplication, bounded pagination, auth/MFA/revocation handling, attachment quarantine, rate-limit recovery and installed-build tests. It may feed this contract but cannot widen it.

## Consequences

The team can test the complete PM interaction and persistence model now, while the UI remains honest about provider readiness. The named-office pilot can replace only the admitted read edge instead of redesigning Desk cases. The trade-off is deliberate: Demo classification is useful product proof, not a claim that RealBud currently reads a real inbox or owns an inbound schedule.
