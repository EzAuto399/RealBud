# Service administration and managed access

Decision: one company subscription, independent staff identities, and a separate service administrator credential for each desktop installation. A company owner is not automatically a service administrator. A service administrator cannot impersonate staff or read their private work.

This is the settings and local admission slice of the two-desktop project. It does not complete remote billing, company worker execution, native deployment or Windows acceptance.

## Everyday workflow

1. Staff open **You** to see Bud's readiness and service status. The company setup/join flow and staff sign-in remain separate.
2. Staff use **Connected apps** to choose their own work accounts. Model, Composio project and messaging bot credentials are absent from this flow.
3. You open **You → Service administration** and sign in with the password for this installation. The section contains model/runtime setup, connection service credentials, optional Gmail read-only configuration and messaging service setup.
4. Lock when finished. The credential is held only in that renderer, expires after five idle minutes or fifteen minutes total, and is not inherited by another window. Lock/expiry unmounts key editors and discards unsaved key fields. A reload requires signing in again.
5. A lost connection or rejected administrator session closes the editors. A late response from an older session cannot clear a newer session or revive an expired one.

The remaining **Advanced** section contains work history, approvals, rules, recovery and diagnostics. These are staff work controls; they do not grant provider authority. Stop and access to saved work remain available when paid assistance is unavailable.

## Provisioning each installation

Use the trusted operator process, not a self-service password creation route in the customer UI. There is no universal password and no staff-accessible administrator reset. Keep a password-manager record keyed by company and desktop; do not share that record through the company database, invitations, workflow packs or customer backups.

Existing interactive provisioning remains supported:

```sh
node scripts/provision-service-admin.mjs --data-dir /absolute/private/installation
```

For automatically generated independent passwords:

```sh
node scripts/provision-service-admin.mjs \
  --data-dir /absolute/private/installation \
  --generate-password-file /private/operator/new-desktop-password.txt
```

- Requires Node 24 or newer. Paths must be absolute. Substitute the actual selected installation and a private operator location.
- Generates a random 192-bit password. Only its salted scrypt verifier goes into the installation's `service-admin.json`.
- The operator file is private, created exclusively, and must be outside the installation data directory. No password or verifier is printed. Transfer the password to your password manager and keep the file out of customer delivery.
- Existing credentials require an explicit `--rotate`; existing operator files are never overwritten. Rotation revokes existing sessions when the server next checks policy.
- POSIX ownership/modes and the existing Windows ACL helper protect the files. Native Windows execution still requires its own acceptance run; macOS results are not Windows proof.
- Generating/provisioning an administrator password does **not** issue a service grant or activate billing. The packaged source already forces managed mode and required entitlement checks. Do not distribute an unprovisioned managed build as an activated customer installation.

No passwords, provider keys or policy on the operator's existing RealBud installation were changed in this pass.

## Payment cut-off: required architecture

Local settings control is implemented. Reliable remote suspension is **not implemented** by a locally signed entitlement file. A person with operating-system administrator control can alter local code/configuration, read local secrets or change the clock. A password over the settings UI does not address that threat.

The intended paid-service boundary is a RealBud gateway operated outside customer-controlled machines:

- Provider/model keys and the Composio project key stay at the gateway. Desktop/company installations receive scoped credentials, never master keys.
- A gateway identity binds the company, member and enrolled installation. Composio account ownership is resolved from authenticated member identity, not a request-supplied email or account id. Staff may have different app accounts under the same managed project key.
- Subscription state is authoritative at the gateway. Suspension denies the next paid admission; queued work and approval-resumed work must recheck it. New model/tool requests cannot use a cached local “active” result as payment authority.
- Already dispatched external operations may finish. Preserve their receipts and do not blindly retry or delete data. Cancellation/Stop remains usable. Define the in-flight policy explicitly before launch.
- Unknown, unavailable, revoked, expired or out-of-budget access gets a clear held result. Reading/recovering/exporting saved work must remain possible without a new model call.
- Member removal, lost-device revocation and subscription suspension are separate controls. Suspending one installation should not accidentally delete another staff member's account or data.

No billing vendor, hosted gateway, deployment, payment webhook or real customer suspension was configured or exercised in this pass. The administrator UI states this limitation instead of presenting a nonfunctional subscription switch.

## Verification in this pass

See [the execution receipt](../outputs/realbud-service-administration-2026-09-15/README.md) for exact counts and source hashes.

- Two real local HTTP harnesses with separate disposable installation directories: password/session isolation, ordinary-window denial, key redaction, rejected key removal/replacement/model switching, privileged provider-login status, successful administrator-only key removal and logout revocation.
- Signed grant expiry denies model readiness/voice admission even with an administrator session, while saved Desk data, profile changes and Stop remain accessible. Replacing it with a valid signed fixture grant restores local admission. This is not a payment-webhook test.
- Session tests exercise idle/absolute expiry, rotation/restart/rollback, in-flight races, active renderer expiry notifications and rejection of stale responses.
- Provisioning tests generate distinct passwords, reject a password file inside customer data, preserve existing files, require explicit rotation and keep credentials out of output.
- Browser walkthrough against an isolated source build: incorrect password; correct sign-in; another window stays locked; unsaved key removed by lock; fresh sign-in has an empty field; staff app/phone views lack provider-key editors; responsive layouts at 1280, 800 and 390 pixels.
- A completed Grok 4.6 xhigh source review was independently checked by root. Broad default-deny advice was not applied to ordinary work routes. Query/trailing-path and bot-creation allegations were checked against the actual pathname router and product-mode denial. The valid payment-authority limitations remain explicit.

## Next release gates

1. Complete the hosted provider/Composio gateway, trusted activation and subscription/revocation flow, including separate-member account binding. Prove immediate denial of subsequent paid requests after suspension without revealing master keys.
2. Wire trusted provisioning into the supported managed installer and activation flow. Prove recovery/rotation, updates, reinstall and device transfer without copying a shared administrator password or losing business records.
3. Package/install this source on the two Macs. Test staff versus service administrator on both, independent Composio accounts, selected-work sharing, private Hermes contexts, local-file/device authority, restart and reconnect recovery.
4. Run the same acceptance matrix on a real Windows environment. Browser resizing, POSIX tests and Windows-specific source branches do not prove Windows installation, ACLs, desktop drivers or worker operation.

The broader operational acceptance register remains open. Do not promote S01–S04 or two-device acceptance to complete from this local settings pass.
