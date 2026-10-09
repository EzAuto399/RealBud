# Release 0.1.48, 9 October 2026

**This does not establish:** customer acceptance, a VM upgrade run, a Mac release, a live Composio Outlook profile readback or a live Modelvia legacy-policy readback. The proof is source, local tests and CI Windows packaging.

## What it is
This release brings the Codex system-foundation work into the product, after review. The Codex work arrived as an uncommitted snapshot (`docs/SYSTEM-FOUNDATION-2026-10-09.md`). It sits on top of 0.1.47 with two review rounds of fixes.

- **Setup and people:** clearer next actions, owner hand-offs, and a return to the original task after sign-in. Office details typed during setup survive a detour. A stale view cannot overwrite newer work.
- **Mail through Composio:** a send is bound to the account the person reviewed, for both Gmail and Outlook.
  - New desktops and the new gateway enforce the binding.
  - Older desktops and the older gateway keep working for one release.
  - Direct (non-Composio) mail sends are removed.
- **Recovery in place:** an earlier failed send no longer blocks mail. An uncertain one is checked by the owner in Connected apps, which never rewrites the recorded outcome. A crash no longer locks connected apps.
- **Offices on more than one computer:** a host and members on different versions keep working. A new member on an old host is told to update the host.
- **Billing (gateway):**
  - resale pricing proof, with old receipts accepted and re-proved;
  - finalized AI invoices are never deferred;
  - true deferral wording;
  - no receipt for a reversed payment.

## Owner decisions, 9 October
1. **Bud runs on Windows and macOS.** macOS keeps `sandbox-exec`. Windows runs Bud without network isolation, as 0.1.46 and 0.1.47 did, until a reviewed boundary exists (a per-program Windows Firewall rule is the candidate). Linux stays held. See `server/worker-network-sandbox.ts`.
2. **Gmail and Outlook are both connected through Composio.**
3. **Windows releases ship.** The CI artifact carries `latest.yml` again. CI never publishes; a release is published by hand after review.

## Deploy order
1. **Gateway first.** Run the read-only volume check in `managed-gateway/DEPLOY.md`. Readback, 9 Oct: uid 0; `/data` 755 (tightened to 700 at boot); every file 600; `/data/secrets` 700. Then run `deploy.sh` from protected storage and check that `/ready` returns 200.
2. **Office host desktops, then members.**
3. **After deploy:** re-sync resale pricing for each resale office before the next month close.

## Evidence
| Check | Result | Tier |
|---|---|---|
| Full desktop suite | see PR | local tests |
| Gateway suite (default macOS TMPDIR) | 490 pass | local tests |
| Release guards | 40/40 | local tests |
| CI Windows (installer + managed runtime) | see PR | CI Windows |
| Independent reviews | two rounds; all medium and high findings fixed | source |

Website: the Codex website work was ported separately (website PR #41, live as `31fee5b`) after its migration `202610090002` was applied following an encrypted backup.
