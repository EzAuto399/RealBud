# REI browser setup and API access — 24 September 2026

This checkpoint does not establish RealBud's connection to the live browser, a completed REI workflow, API entitlement, financial posting or customer acceptance. It records the owner's [browser-first sequencing](decisions/2026-09-24-rei-browser-first-api-when-approved.md), current source checks and a limited read-only browser observation.

## What is verified

The owner confirmed the working login is on this Mac. Codex's browser tooling located the existing **Brave Browser** REI session and read the authenticated Agents page at `https://app.reimasterapps.com.au`. The page exposed the application navigation without a sign-in form. No page action, record change, credential read, file export or upload was performed. Private agency/account identifiers are intentionally omitted from this checkpoint and fixture outputs.

The currently selected RealBud native window showed fresh welcome. Read-only listener/process and bundle metadata identify that service as `/Applications/RealBud.app` **0.1.18**, not the newly qualified 0.1.19 candidate. It was left unchanged; the data-profile identity still needs confirmation before onboarding or replacement. Metadata receipt: `outputs/rei-browser-first-2026-09-24/app-identity-metadata.json`. Codex's ability to inspect Brave is not proof that RealBud's separate BrowserSkill connection works, and Brave compatibility has not been qualified for RealBud. Current product setup copy names Chrome/Edge; the runtime admits connected profiles by helper/protocol compatibility rather than a hardcoded browser brand.

Current source already includes task grants, central browser authority, a broker, selected-browser and account checks, observed-control checks, approval handling, upload/download/key/select operations and sign-in recovery. The older browser-design document's unbuilt wording is historical. A focused run on source/evidence head `d7906bf480f6926520a0e663f50a5acd3022ca7d` passes **240 / 0 / 0** tests in six files: browser task, authority, broker, runtime, attended run and task sign-in. This is local contract proof, not live execution.

Receipt, raw test JSON and hashes: `outputs/rei-browser-first-2026-09-24/receipt.json`, `browser-contract-tests.json` and `browser-contract-tests.log`.

## First browser qualification

| Stage | Check | Evidence needed |
|---|---|---|
| Select the installation | Identify the intended RealBud executable/profile; preserve existing work; keep the Windows VM task separate | Exact app/artifact and data-profile identity |
| Connect the browser | In You → Browser, use the reviewed helper/extension, select the actual work profile, keep tab confirmation and requests for help enabled | RealBud reports the selected compatible profile; no cookie/password copying |
| Confirm the REI context | Borrow only the intended REI tab and verify the visible agency/account marker; stop on missing or changed identity | Product-generated scope and readback receipt |
| Run one bounded task | Read a selected permitted record/report, navigate away/back, check pagination/empty results, Stop/takeover, and recover from a real login pause or disconnection without repeating work | Actual result and refusal/recovery observations; unrun rows remain unrun |
| Extend the workflow | Validate a specifically approved export/file and preview; test uncertainty and duplicate recovery on fictional/sandbox data before any approved real write | Preserved source hash, preview/result comparison and actual acceptance; upload alone is not successful import/posting |

A real browser connection may make approved page content available to the configured model and work history. Keep the task narrow and use only the records/files needed. Existing authority and per-instance consequential approvals remain in force; nothing here authorises automatic payments, posting, notices or sending.

## API request track

The official [developer sign-in](https://reimasterapi.developer.azure-api.net/signin) directs prospective developers to contact REI Cloud. The [billing policy](https://reicloud.com.au/subscription-billing-policy/) lists `admin@reimaster.com.au` for account/billing enquiries and says integrations may have additional charges. No API-specific fee, per-seat requirement, scope or entitlement was established by the pages checked.

Ready-to-review draft: `outputs/rei-browser-first-2026-09-24/REI-API-ACCESS-REQUEST.md`. It asks for custom/partner eligibility, documentation/sandbox/auth, relevant read and later import-preview/receipting capabilities, charging basis/limits, versioning/sync/audit and browser-assistance requirements. It is **not sent**, accepts no charges and contains no customer data or credentials. Use the normal agency support channel to provide account identification if requested.

Prefer a granted, documented API for supported operations; retain browser handling for the rest. Do not build against guessed endpoints or infer support from the developer portal's generic marketing sample. Reads, writes, retries and adapter fallback must retain the same account scope, approval and result-reconciliation rules.
