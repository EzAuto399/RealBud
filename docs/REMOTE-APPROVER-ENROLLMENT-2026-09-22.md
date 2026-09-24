# Attended remote-approver enrollment — 22 September 2026

This checkpoint connects the stable portal identity prerequisite to a workspace-specific, attended enrollment. It is preparation for the remote review/decision/claim path in [the website command protocol](WEBSITE-COMMAND-PROTOCOL-2026-09-22.md). Enrollment alone does not upload private work plans, read mail, run a worker or approve execution. The full RealBud goal remains active.

## Implemented behavior

On the desktop, a person selects reviewed preparations and a workspace name, reads the complete typed disclosure templates and approves their exact digests. The two existing private-work adapters are supported: a reviewed preparation recipe and Morning priorities. Mailbox aliases replace connection identifiers. Plans that implicitly read the private book remain local. Only descriptor labels and exact template digests are uploaded during enrollment; template text stays in the encrypted local workflow database.

A new protocol-2 parent permission is saved durably before publication. A permanent local marker and server-side version floor prevent a protocol-1 downgrade. Each invitation has immutable target, generation, scopes and deadlines, an authenticated server-clock baseline, a ten-minute challenge, and at most thirty days of approver validity. The code is shown only in desktop memory and submitted through the portal form, never through a URL or browser storage.

The portal derives the person and company from the current verified server-side identity, requires a fresh sign-in for acceptance and records only a candidate. A local person must separately review that named candidate and confirm the exact revision/digest. A signed-in person may list and disconnect their own connections. The desktop can revoke invitations, revoke a person or disable the parent permission. Legacy cookies and other-agency identities cannot accept an invitation.

Lost publication and confirmation responses retain the exact original identity. Ambiguous parent publication can be cancelled using the original installation reporting authority: one SQL transaction creates or finds the exact parent and records its revoked result, preventing a delayed publication from activating it. A later setup uses a new generation. Revocation does not require current source/template readiness. Local encrypted history excludes command tokens, challenge secrets and confirmation outboxes; both backup formats restore templates unapproved and history inert.

## Recovery correction and proof status

Actual desktop/browser/Next/PostgreSQL testing found that a cold restart starts with an unverified connection-status cache. The saved configuration, worker fingerprint and ordinary preparation descriptor were unchanged, but Morning priorities was temporarily unavailable. The original implementation prevented status polling under this hold and also overwrote an authoritative revoked phase with “stale.” The read-only recovery path now checks the exact local workspace/member, saved transition, matching website installation/company and command authority independently from executable source readiness. Inactive authoritative receipts remain inactive; begin/confirm continue to require full current readiness. An active receipt cannot be adopted while that readiness is unverified.

A second visual defect retained the portal instruction to return to the computer after confirmation. The banner now follows the latest validated state of its associated enrollment.

Final verification is recorded in [verification.json](../outputs/remote-enrollment-2026-09-22/verification.json):

- Full final source: **4,630 passed, zero failed, 191 environment-gated skipped**, across 345 passing and 21 skipped files. The 75 focused enrollment/v1/transport tests are included in that total.
- Website unit tests: **55 passed**. Disposable real PostgreSQL: **179 assertions passed**, with migration/shared-contract hashes still matching the final source.
- Desktop and website production builds passed. The desktop build retains its existing bundle-size warning; this is not a performance or native-package acceptance claim.
- Four actual desktop/Next/PostgreSQL/browser groups passed: both local templates, lost parent publication and atomic cancellation, legacy/cross-agency denial, attended confirmation after lost reply, unchanged restart plus source outage/recovery without re-enrollment, and portal revocation while stopped followed by cold-start reconciliation. Source recovery did not resurrect revoked access. **Zero mailbox scans or worker calls** occurred, as required for enrollment; the site recorded 40 RPCs and no fixture violations/database errors.
- Rendered desktop/mobile evidence was inspected. The desktop shows the source hold and saved workspace, hides replacement setup and disables new invitations; revoke/disable remain accessible. The portal banner follows confirmation instead of retaining the pending instruction. No horizontal overflow was observed in the checked mobile views.

The final product/unit source remained frozen through these checks; only the GUI harness changed to hold an explicit connector-status outage because the renderer automatically checks connections on startup. Hash manifests preserve that distinction. Failed runs are retained separately: the original restart/revocation defect, an early GUI-label mismatch, a startup sync race, the nondeterministic hold observation before the explicit outage, and a full run launched during earlier edits. Two old unit expectations were updated to assert a held read-only result rather than expecting every status read to reject; mutation fences remain tested. Successful GUI cleanup was confirmed.


## Remaining work and release limits

Use the current [decision/claim integration map](../outputs/remote-enrollment-2026-09-22/decision-claim-integration-map.md) for exact source seams and verification requirements. Complete protocol-2 review publication, exact audience-bound portal decisions and online claims through the existing local executors, including cancellation, restore and crash recovery; then add scoped shared-department execution. No enrolled identity is an execution approval.

This checkpoint uses disposable local PostgreSQL, built Next routes, the real desktop service and rendered interfaces with fictional identity/mail/worker fixtures. It does not establish hosted migration, live authentication, real bank/Gmail/REI acceptance, installed native Windows operation, new packaged macOS acceptance or a customer rollout. No deployment, live customer mutation or installed-app replacement occurred.

The bounded Grok attempt requested 4.7/xhigh, but the session advertised 4.6/xhigh. It was stopped before sending a prompt; cleanup was verified. This is neither a completed 4.7 review nor proof that 4.7 is unavailable generally.

A distinct metadata-only follow-up inspected the fresh session’s complete model choices: `grok-4.6` and `grok-4.5` only. No 4.7 value was offered, so no model selection or prompt was sent. The process was reaped, its private home removed and global configuration unchanged. This used the documented [ACP configuration-option contract](https://agentclientprotocol.com/protocol/v1/session-config-options) to distinguish an available selector from a requested CLI flag; it establishes only this session’s availability. See `grok-model-selection-run.json`. Retry 4.7 only when fresh offered choices or another verified supported path changes.
