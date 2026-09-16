# RealBud two-profile test guide

The core target is two desktops, two private profiles, one host and one PostgreSQL database. A separate business brain is outside this core. This kit exercises company setup, joining and dormant workflow templates with synthetic data. It does not enable a shared Hermes worker, live app connection, desktop control or customer workflow.

## What to open

This test kit requires **Apple silicon and macOS 26 or later on both Macs**. It is not an Intel or earlier-macOS build. Check About This Mac before starting. Keep the extracted folder in the same location after creating the host; moving or replacing its database runtime requires a managed migration, not a copied data folder. This is an internal synthetic test bundle with ad-hoc-signed native dependencies, not the signed/notarized customer installer. If macOS blocks a launcher, record the exact message; do not disable Gatekeeper or strip quarantine.

1. On the host Mac, open **Start Host.command** and open the local address it prints. The kit includes Node and a relocated test PostgreSQL runtime; it does not install a system database or alter your existing RealBud workspace. In first-run onboarding, continue with the tester name, then choose **Open the sample desk first**. Model setup is intentionally unavailable in this kit.
2. Under **You → Advanced**, sign into service administration with the synthetic kit password `RealBud-Synthetic-Lab-2026`.
3. Under **You → This office**, choose **Set up this computer as host**, then create a synthetic company with your test username and password. Save the returned personal recovery key. Version 2 saves the member and sign-in together; older version 1 kits require the separate **Set up or change your sign-in** step before closing the window.
4. Expand **Let another computer join**. Enter the host Mac's network name or office-network IP address. Use `127.0.0.1` only when both test profiles run on this same Mac. Keep the host awake, both Macs on the same network, and obtain the host code.
5. Create an invitation for the second tester. The host code identifies the host; the one-use invitation grants membership. Share both privately with that tester.
6. On the second Mac, open **Start Second Profile.command**, complete the same sample-desk onboarding, and go to **You → This office**. Paste the host code, connect, enter the invitation and that member’s independent username/password together, then save the recovery key.

For a one-Mac rehearsal, open both launchers on the same Mac. They use separate processes, local ports, profile directories and member identities. That is useful concurrency/restart evidence, not proof of networking between two physical Macs.

## Import the three practice plans

Use only the included `practice-pack.json` and fictional information.

1. On the host profile, open **Schedule → Import office packs → Restore snapshot** and select `practice-pack.json`.
2. Verify the three plans appear: synthetic morning priorities, expected bills and payment references. They must stay off and unapproved.
3. Under **Company workflow templates**, refresh, select **Review my plans for sharing**, expand the details to inspect steps, result, capability requests, website scope and limits, then select **Share with company**.
4. On the second profile, refresh company templates and select **Import company plans for review**. Verify the same plan text and that approvals, schedules and computer attachments were not copied.
5. Import again: there must be no duplicate plans. A conflicting local edit must be held for review, not overwritten.
6. Stop and restart each launcher, sign back into the same member, and verify the company template and local imported plans remain.

The imported plans are preparation instructions. An imported plan is not proof that its source is connected, a model ran, an office clock was coordinated or REI accepted a file. Leave the practice plans off. The existing sample-book calendar may show sample routines; those are local training behavior, not a company clock. Shared scheduling and company-scoped Desk/Ask execution remain work to complete.

## Stop and recover

Closing browser tabs leaves the test service running. Keep the launcher open; **Ctrl-C** requests orderly database shutdown. Each launcher also stops after two hours. Data is retained under `~/.realbud/test-lab/two-profiles-2026-09-14`, with separate `host` and `client` folders. Existing `~/.realbud` office data is not used.

Do not remove an ownership/launcher lock or reuse a live database directory to force a restart. A failed or uncertain stop requires checking the owning process and preserving the data first. This kit is not an installed background service; reboot/unlock, sleep/wake and crash recovery remain explicit acceptance work.

## Windows evidence

`Run Native Checks.command` executes real PostgreSQL/TCP concurrency and restart checks on the Mac where it runs. The equivalent Node runner is portable and records its actual OS. It never reports a simulated Windows pass.

The manual **Company native acceptance** GitHub Actions workflow installs PostgreSQL 16 on disposable Windows Server and Mac runners, executes the portable rehearsal, TLS/template tests and a compiled-dependency smoke check, and retains receipts. It must run from the reviewed source revision. The workflow file existing is not a passing cloud run. Windows Server results will still leave Windows 11 UI, device permissions, Cua, installer signing and the client's actual computer unverified.

## Record the result

Record both Mac models/CPUs/macOS versions, host name, build/kit hash, setup duration, every failed step, and whether the host remained available after restarting each profile. Keep recovery keys, passwords, host connection details and customer data out of shared screenshots and issue reports.

Current remaining gates: native Windows/macOS installers and independent services; enrolled-device authority; company-scoped Desk/Ask/Schedule; isolated stock-Hermes workers and managed model routing; exact-account Composio access; Cua/browser/CLI parity; off-device service entitlement enforcement; complete three-workflow live-source and customer acceptance.
