# Core first; initial workflow scope

Status: owner clarification in conversation on 23 September 2026. This is a scope and sequencing decision, not proof that the core is complete.

## Delivery order

Complete and verify RealBud's reusable core before extending or accepting the customer workflow packs. Core acceptance must include a fresh workspace and a fictional, non-property-specific job, so a successful customer demo cannot hide missing platform behavior.

The first packs are **bank → CSV**, **email → bills → calendar**, and **email → morning priorities**. Bank work ends at the prepared/reviewed CSV for now. REI Cloud upload, recognition, import, posting and an REI simulator are deferred and do not block this stage. Preserve existing source files, review decisions and historical REI work; this decision does not authorize deleting them or changing financial records.

The email outcomes are provider-neutral product requirements. Gmail is an existing adapter, not a claim that every email provider is implemented. Exact bank, account, date-range and CSV mappings are later pack/source configuration.

This supersedes the delivery sequence and current REI acceptance requirement in the 21 September business-OS decision and the earlier manual QA run sheet. Existing privacy, approval, compatibility and recovery constraints remain.

## What belongs to the core

| Core owns | Pack supplies |
|---|---|
| Private/member/office identity and department permissions | Business roles, configuration and terminology |
| Account connections, scoped tool execution and source/file evidence | Which permitted sources a workflow uses and how their fields map |
| Jobs, results, review, Stop, retries and durable receipts | Workflow steps, output contracts and domain-specific validation |
| Calendar primitives, timezone and scheduler recovery | Bill recurrence, priority rules and chosen schedules |
| Persistence, backup/restore, versioned extension lifecycle and diagnostics | Versioned views/instructions/configuration using those core contracts |

Packs must not implement a parallel permission system, scheduler, credential store or retry mechanism. A department workflow requires an explicitly authorized department source; it cannot inherit someone's private mailbox or browser merely because the person belongs to that department. A separate department is a scope within one office; an independent office needs separate installation/data authority.

## Core acceptance before customer-pack testing

1. **Start and connect.** One fixed candidate installs, opens a neutral workspace, resumes the same private identity and can attach its supported worker/accounts. Missing credentials, offline service and unsupported capabilities have actionable states. Verify actual packaged startup, not only TypeScript or source-server startup.
2. **Acquire and execute.** A fictional generic job acquires an explicitly permitted file, preserves exact bytes and provenance, produces a reviewed result and retains it after restart. Ask, delegated work and saved/scheduled jobs enforce their declared capabilities consistently. Stop, stale approvals, expired login and unknown external results cannot silently continue or duplicate effects.
3. **Isolate and preserve.** Separate members/offices cannot read or mutate each other's private data. Department access, revocation and read-only roles are enforced by the service. Missing data differs from damaged/unreadable data: corruption holds writes and preserves evidence. Backup/restore retains records and invalidates restored authority.
4. **Extend and recover.** Import a fictional non-property pack through the supported contract; preview/approve it, run it, upgrade/revert it, and disable it without losing core records. Customer-specific bank/bill surfaces must be attributable to enabled capabilities/packs. Arbitrary privileged extensions are not part of this promise.
5. **Perform on supported devices.** Record candidate hash, hardware, OS, dataset sizes, cold startup, warm UI/local API latency, job dispatch and Stop latency, resident memory, history growth and restore duration. Run a repeat/idle/restart exercise on Mac and Windows. Set regression budgets from observed baseline and expected office workload; no unmeasured claim of unlimited capacity or acceptable performance for every use case.

These are engineering acceptance criteria. Passing local fixtures is useful evidence but does not establish installed-device, live-account or customer acceptance. Platform-specific unavailable capabilities remain named limitations until implemented and verified; do not disable safeguards to obtain parity.

## Current work

Use [the core readiness checkpoint](../CORE-READINESS-2026-09-23.md) for concrete findings, bounded fixes and verification. Preserve the active browser-authority work's ownership. Establish a fixed candidate after integration; do not package a moving working tree and label it a complete release.
