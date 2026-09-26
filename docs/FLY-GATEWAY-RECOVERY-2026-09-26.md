# RealBud managed gateway Fly recovery check — 26 September 2026

This is a live infrastructure receipt, not a customer or payment acceptance. The gateway remained on its original Machine and volume throughout the check.

## Current volume and backup

- At 09:15 UTC, Fly listed Machine `83d170ea735528` as started in Sydney with one passing service check. Its `/data` mount was volume `vol_r68ylq8qp2w3qqp4` (`gateway_data`, encrypted, 3 GB).
- Three other `gateway_data` volumes were detached. Their contents and provenance were not established, so none was modified or deleted.
- The active volume reported `auto_backup_enabled: true`, five-day snapshot retention, but Fly returned no existing snapshots for any of the four volumes at the initial readback.
- A manual snapshot of the **attached** volume was scheduled and then read back as `vs_4B5xKQ0zex46ckbMxkp9p`, status `created`, 69,955,453 stored bytes, with five-day retention. Fly's daily automatic snapshot setting remains enabled; the first automatic run and any alert on failure have not been observed.

At 11:15:33 UTC, a second manual snapshot of the attached volume was created
as `vs_kZgqeDKLmq7Qs7nmQOz3j` before the invoice migration. It has not been
restore-tested. At 11:40:03 UTC, a third manual snapshot was created as
`vs_ZkljPyex1j26Tzj5QPBk2`, with five-day retention.
It includes the private desktop service signer held on that encrypted volume.
No signer material, key path or public-key digest is recorded in this receipt.
The signer has not been restored from this snapshot, so its recoverability is
still unproven. The active volume continued to report automatic backups
enabled with five-day snapshot retention; the first automatic snapshot was
still not observed.

## Isolated restore proof

The snapshot was restored to a new encrypted Sydney volume named `gateway_restore_qa`, ID `vol_v3g5p9yyeppz27w4`. Automatic snapshots were disabled on this disposable volume. A one-shot Machine using the deployed RealBud gateway image mounted **only this restored volume** at `/restore`, exposed no service port, and exited normally with code 0. Fly removed the one-shot Machine. The production Machine continued serving and remained the only Machine in the app after the test.

The one-shot check opened the restored SQLite ledger with the production `LedgerDatabase` code, which verifies the event hash chain. `PRAGMA quick_check` returned `ok`; application ID was `1380075351`, schema version `3`, with 5 events, 1 tenant and 0 invoices. This restore used the **first manual** snapshot. The restored volume had no connector registry file, protected project-key files or desktop signer at that checkpoint, so this test cannot prove their later recovery. It did not expose record bodies, customer data or credentials.

Afterward, public `https://realbud-managed-gateway.fly.dev/ready` answered `{"ready":true,"provisioning":"composed","modelviaOperator":"configured","operatorAccess":"configured"}`. Modelvia `/ready` and `realbud.app/` also answered successfully; those probes do not prove end-to-end desktop requests or payment acceptance.

## Remaining operating gates

1. Verify the first **automatic** snapshot appears, then monitor snapshot age and failure. All three manual snapshots expire after their five-day retention windows.
2. Restore the 11:40 signer snapshot into an isolated environment and prove the signer is recoverable without printing it. Also check the provisioned connector/project-key records and any finalized invoice, including revocation state and reconciliation against newer live events, without promoting the old copy into production.
3. Remove the disposable `gateway_restore_qa` volume after owner confirmation; it is a separate billable 3 GB volume. Do not remove any detached `gateway_data` volume before identifying its origin and preserving needed data.

[Fly pricing](https://fly.io/docs/about/pricing/) lists volume capacity at US$0.15/GB/month, prorated, and the first 10 GB of snapshot storage free each month. Prices and account billing should be rechecked before a longer-lived recovery environment is kept.
