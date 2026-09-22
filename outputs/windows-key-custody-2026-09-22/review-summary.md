# Independent design review — Windows desk key custody (22 September 2026)

Requested model `grok-4.7`, reasoning effort `xhigh`, run as a fresh `agent --no-leader` stdio ACP
session in a disposable private home. One prompt completed with **zero tool calls** and zero
permission requests in **~207 s** (terminal 204.3 s, `end_turn`). It saw prompt metadata only, no
repository access: a design opinion, not a code audit. Raw: `grok-acp-windows-fixture-run.json`.
**Verdict: conditionally acceptable** — a pre-existing key directory is fine for confidentiality
provided every key file carries its own verified protected descriptor; same-user and
administrator readers stay trusted.

Required checks, now implemented in `electron/desk-key-custody.mjs`:

- The wrap's temp file is restricted before any key byte, and a helper failure fails closed with
  "needs recovery", returning no key and minting no new identity.
- The published name is re-verified after the rename, and every preserved
  `desk.key.wrap.recovery-*` copy is restricted before its bytes and verified after. The temp is a
  sibling of its destination, so the rename stays on one volume and inherits no destination ACEs.
- The descriptor is compared semantically — protected (no inherited ACE survives), owner and
  every Allow principal limited to the current user, SYSTEM and Administrators, one
  non-InheritOnly FullControl grant required, any Deny refused — never as loose SDDL text.

Accepted boundaries, not defended against: the same user's other processes, SYSTEM,
Administrators, a SeBackupPrivilege holder, and any handle opened before the lockdown can read
the key. A tolerated pre-existing directory still permits `FILE_DELETE_CHILD` swaps and planted
reparse points; those are refused at open/verify time, not prevented.

Windows-only runtime list (verbatim): "Real NTFS must show protected owner and DACL, zero
inherited ACEs, null-DACL refusal, same-volume versus cross-volume rename, reparse and hard-link
refusal, a planted directory, delete-child, low-integrity open, and elevated owner. Script byte
parity leaves runtime behavior unproven." None of that is observable on the macOS host used here.
