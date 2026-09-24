# Local office operation and recovery

Implementation: 20 September 2026. This runbook describes the local source build. Installed Windows/Mac acceptance, a real office network and a deployed website are separate release gates.

## What stays independent

A private workspace has a stable `company-installation/workspace.json` identity. Joining, signing out, disconnecting or leaving an office does not select a different Hermes profile. Existing member-based profiles are retained on upgrade; existing solo profiles remain solo profiles internally. Do not copy or rename Hermes homes to join an office.

Private Desk work, the local property book, chats, sources and schedules remain local. External models and connected apps still require their own available services and permissions. Shared office work is explicitly reviewed content; membership never grants a colleague's account credentials or desktop control.

## Start alone, host or join

1. Under **You → This office → Local office collaboration**, choose **Use on my own**, **Join an office** or **Host this office**.
2. A host uses one existing office computer. The service administrator prepares its admitted database runtime; the owner creates their own sign-in and saves the personal recovery key separately.
3. Enable joining using the actual reachable network name or IP. Give the intended person both the host code and their separate one-use invitation. The host code identifies a computer, not membership authority.
4. A new member joins once. An existing member signs in. If enrollment has an uncertain result, use the username/password from that attempt to sign in; do not replay or replace the invitation.
5. Check the current office/member shown, then use **Desk → Shared work** to exchange reviewed work. Keep the host running, awake and reachable while colleagues collaborate.

## Membership and daily recovery

| Action | Effect | Recovery |
|---|---|---|
| Sign out | Revokes the current session; retains office binding and private workspace | Retry an unconfirmed logout. Sign back in as the same member. |
| Disconnect computer | Revokes the current remote session and detaches this workspace | Other sessions and office membership remain. |
| Offline disconnect | Detaches locally and records that remote revocation is unconfirmed | Explicit acknowledgement is required. Ask the owner to revoke access if needed. It does not claim to leave membership. |
| Leave office | Deactivates membership and revokes all its sessions | Owner must transfer ownership first. Open owned/assigned work and held claims must be resolved. A saved receipt reconciles a lost response after restart. |
| Remove member access | Owner revokes the member's office sessions | Shared records remain. Unfinished assignments may need an authorised reassignment; active claims remain in recovery. |
| Transfer ownership | Current owner offers; named recipient accepts within 24 hours | Acceptance changes only company scope ownership and revokes unused invitations. It does not move hosting or private work. Cancel/expired/stale offers cannot be accepted. |
| Unknown share result | Encrypted original request remains on this computer | Retry the same request ID and content, including after restart. Inspect existing shared work before creating a replacement. |
| Archive unknown share | Keeps an encrypted local receipt and releases that pending attempt | This is not remote cancellation. Download the receipt under Connection and share recovery; store its reviewed text/evidence privately. |

The local recovery panel is available even when the host is offline or membership has been revoked. It offers the newest 50 archived share receipts; older encrypted files remain in the workspace. Do not delete pending journals to unblock a workflow.

As of 21 September 2026, **Connection and share recovery** also retains a separate encrypted receipt for each offline disconnect. Restarting, joining another office or disconnecting later does not replace earlier receipts. The previous single-receipt format remains readable. The panel shows up to 50 recent records and preserves older files. A local disconnect interrupted by a restart finishes from the same saved journal without contacting the remote office.

**Past office access still needs checking** remains visible in the recovery heading. Open its records to find the office/member references, then ask each office owner to check membership and remove access that is no longer needed. These records cannot confirm remote revocation; there is no automatic clearing or button that pretends to revoke it. They do not block private work or joining another office. Full offboarding still requires the office owner's confirmation.

## Backup scope and limits

**Host backup and recovery** requires local service administrator access. Generating a backup or activating an existing office additionally requires its current owner to sign in. These routes are absent from the company LAN API.

An office backup includes all fixed product tables in the office database, including access-restricted office records, member sign-in verifiers, shared work/history and audit records. It excludes private Bud/Hermes homes, local property books, local files, connected-app credentials, service-administrator credentials and the old host TLS private key. A private workspace backup remains a separate, unimplemented lifecycle requirement.

Use a 16–256-character passphrase and store it separately. The backup is encrypted with AES-GCM using a scrypt-derived key. Built-in limits are 32 MB of plaintext office data, 100,000 rows and 48 MB of encrypted backup JSON. An oversized office fails without issuing a partial backup; it needs an assisted database backup. No automated backup schedule or retention policy is implied.

“Generated” means the server produced an encrypted file and a SHA-256 receipt. “Download requested” does not prove that it was saved elsewhere. Verify the downloaded file and maintain a separate copy. A successful restore drill is distinct from backup generation.

## Planned host move

1. Resolve outstanding collaboration and tell staff to stop submitting work. Confirm the replacement computer can run the admitted database runtime.
2. On the source, choose **Move this office**, then **Retire host and generate backup**. The service drains in-flight company requests, persists the retirement hold and makes a consistent final snapshot. Collaboration stays held on restart. A failed download leaves the source retired; retry backup generation there.
3. Verify the encrypted file was saved. Preserve the source data until replacement acceptance; do not delete it as part of cutover.
4. Prepare empty host storage on the replacement. Choose the backup and passphrase, then **Restore and hold**. Uploaded SQL is never executed: fixed table data is validated and restored transactionally.
5. A restored host starts in standby. Old sessions and unused invitations are revoked. Outstanding claims are fenced and marked for recovery. Sign in with the existing owner's credentials.
6. Verify the backup date, office identity and restored work. Changes after the backup are absent. Confirm every previous host has stopped serving this office, then activate the replacement.
7. Enable joining on the replacement. Each companion uses **Connection and share recovery → Host unavailable or replaced → Reconnect to replacement host**, then signs in as its existing member. Same-office identity is enforced; pending unknown shares must be reconciled or explicitly archived first.
8. Run an actual installed-device join/share/restart/outage/recovery walkthrough before admitting the office.

An isolated LAN has no independent quorum capable of proving that an unreachable original host has stopped. Activation requires explicit operational verification; the product does not claim automatic global split-brain prevention. A restored snapshot must not be activated alongside an old active host.

## Disaster recovery and failed restore

- Wrong passphrases, altered ciphertext, incompatible migration checksums, unknown columns, cross-office rows and constraint failures do not partially populate an office. Existing offices cannot be overwritten.
- An empty host held after a failed restore can retry with a valid backup or use **Cancel restore on empty host**. That operation refuses an existing office.
- A crash after database COMMIT but before the local restore receipt is resolved from the database audit receipt. A missing local lifecycle file on a previously restored/retired host causes a hold, not silent activation.
- Damaged or missing encryption keys are never regenerated over existing private journals. Preserve files and recover the correct key.
- Restoring sign-in verifiers does not reveal a password or let service administration impersonate the owner. Without owner credentials or a valid personal recovery key, activation remains blocked.

## Certificate and address renewal

An expired network certificate keeps company joining offline while preserving local database access. The owner and service administrator can use **Renew certificate or change network address**. Renewal disconnects current TLS clients and issues a new host code; all companions explicitly reconnect to the same office. Expired codes are admitted only when reading already-saved state for recovery, never for a new pairing or live TLS trust.

## Explicit release limits

The website link reports an installation; it does not grant LAN membership or remote execution. Enrolled-device identity, website-to-office association, remotely submitted commands, complete office closure/retention, private workspace restore and per-provider workflow admission are not implemented by this lifecycle patch. Existing company-worker/remote-control gates remain closed. This runbook and local tests do not establish deployment, installed-device behavior or customer acceptance.
