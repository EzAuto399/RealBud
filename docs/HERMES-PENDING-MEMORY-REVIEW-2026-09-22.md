# Pending Hermes memory review

Updated 22 September 2026, Australia/Brisbane. The authenticated pending inbox works in the tested macOS source application and unsigned package. The broad source suite passed 4,247 tests with 143 environment-gated skips and zero failures across 335 files. A subsequent UI recovery-version fix passed 19 focused tests, typecheck/build and a fresh package with ten browser checks plus native Mac smoke; earlier receipts are retained. The installed `/Applications/RealBud.app` is unchanged. This is not a whole-product production-readiness claim.

## Behavior

Settings → Bud memory shows native pending additions, replacements, removals and atomic single-target batches. A user sees the complete saved target and proposed result, with literal text and spacing, before approving that exact version once. Rejection preserves memory. Saved history survives page reload. New conversations use the resulting preferences; an existing Hermes prompt remains its frozen snapshot.

These preferences do not update business records, bank references, credentials, subscriptions or work permissions. Staff may approve the precise preference-decision route while provider setup remains protected by service administration. Reads and decisions both require the renderer session and existing Host/Origin checks. Request bodies cannot choose a workspace, profile, runtime, path or key.

The service selects the authenticated worker profile and admitted runtime. Eight native import files are SHA-bound to Hermes 0.21.3, commit `345cd2b057a452236de401d3534b8502a7465e8d`. The owned Python helper reuses native mutation closures through a dry-run MemoryStore; upstream source is unchanged. Native matching, threat checks, target flags and final-state batch budgets remain in force. Unsupported schemas, malformed config, duplicate keys, links, foreign/nonprivate files, ambiguous selectors, credential-looking previews and unsafe controls are held.

## Decision and recovery

- A keyed, domain-separated digest binds pending bytes, complete before/after text, configuration and workspace/profile/runtime. The public API releases it only with a valid complete preview.
- Native target locks serialize memory mutation. Configuration and pending target are rechecked after lock acquisition; live config, proposal and memory are checked immediately before commit. Config edits are not an OS multi-file transaction; hostile same-OS-user/admin changes are outside this filesystem isolation guarantee.
- Signed intent precedes memory writes. A final receipt precedes pending cleanup. A repeated decision returns its stored result and never applies the mutation twice. Opposite decisions and changed ID collisions remain held.
- Interrupted approval checks exact before/after digests. Matching after-bytes are fsynced and verified before completion is recorded; matching before-bytes require the original decision and bindings. Other bytes require service recovery.
- Cleanup claims a native pending pathname into a private owned directory before verifying and deleting it. A replacement proposal captured by a concurrent race is preserved for service recovery. A newer native proposal beside a saved claim is preserved too.
- `.realbud-memory-reviews` lives under the worker profile, outside business backups. Signed receipts contain digests and decision metadata, not memory text. A retained cleanup claim contains the original pending payload and is private recovery data; it is not silently discarded.
- The screen serializes reads and decisions, clears stale confirmation, and reconciles saved state after an uncertain response. It can resume only an already recorded approval/rejection. Failed reconciliation is not proof that an item disappeared. After a lost response, the saved digest and decision must match the exact dispatched intent; a reused ID or different profile receipt stays held. A fresh pending row requires a new complete preview. React effect restart drains the older request before refreshing and retains any uncertain dispatched intent.
- The helper has bounded output and a 20-second execution deadline; the browser allows 35 seconds. Shutdown aborts and drains owned helpers. No provider credentials enter their environment. A post-dispatch unreadable/unknown response requires recovery, never an assumption of failure or success.

The pending/config/current-file ceiling is 128 KiB, at most 100 batch operations, a configured limit of 1–100,000 Unicode code points, 20 list items per page and a combined 2,000 directory-record admission cap. These are conservative local bounds, not an indefinite retention or throughput guarantee.

## Verification

Receipts are under `outputs/hermes-memory-review-2026-09-22/`; overlapping test sets must not be summed.

- Broad source regression: 4,247 passed, 143 environment-gated skips, zero failures across 335 files (`full-suite.json`). The 1,047 recorded inputs stayed unchanged through that suite and first package; `source-before-suite.json` records the boundary.
- Frontend/controller: 19 passed after the final recovery-version correction (13 at the full-suite snapshot); service/contract: 87 passed after Grok follow-up fixes. These focused counts overlap the broader suite.
- Native store: 23 passed against the admitted runtime in isolated fictional profiles. Includes actual owned-process deadline termination, replacement/rejection, batches, Unicode, shrinking over-limit removal, configuration/pending/current drift, cross-workspace token binding, malformed/linked/oversized files and whole-text preservation.
- Recovery: 13 subprocess fault tests passed using actual native MemoryStore. Crashes before/after memory fsync, after intent/final receipt and during cleanup retain exact-once behavior. Physical power-loss durability is not established by process exits.
- Actual managed source bootstrap and built UI: 10 checks passed (`browser-managed-final/receipt.json`). No renderer session exposes no memory; staff cannot mutate provider setup or read login codes, while reviewed preference decisions require no admin session. Native preview/apply/reload/stale-rejection/rejection, 390px layout and enabled Apply contrast passed. Desktop/mobile screenshots were visually inspected. No page errors or off-origin browser requests; all fixture processes/files were cleaned up.
- Frontend/server typechecks and builds passed. The compiled server contains byte-identical owned Python helper code.
- The first fresh unsigned macOS package passed its general smoke and ten dedicated packaged-memory browser checks (`packaged-browser/receipt.json`). That journey runs the packaged Electron/Node executable, compiled bootstrap, bundled UI and owned helper, with exact resource hashes and no source fallback. The final UI recovery-version fix follows this first package. Its replacement `package-final/mac-arm64/RealBud.app` also passed native Mac smoke and all ten dedicated browser checks (`packaged-browser-final/receipt.json`). The final desktop/mobile screenshots were visually inspected; no page errors, off-origin requests or admin headers were observed, and all fixture processes/files were cleaned up.

The final source manifest contains 1,047 inputs, digest `55056fe71c1b6d51b8afd9d8c564169f4040f188ab5b9311e57ec7f5d683e3a5`. Only `MemoryReviewPanel.tsx`, its test and the packaged-mode QA harness changed after the broad suite. The application change is the exact digest/decision reconciliation correction; 19 focused UI tests and the final package verify it. No full-suite rerun on those later inputs is implied. All recorded source inputs remained unchanged through final package QA.

The final package manifest contains 2,411 files and 14 symlinks, digest `32c607b3c887fd5dbc7ebfc717714cde8bf0c5bc9897743ad0892b5ae5a88be9`; every recorded entry was unchanged after QA. The packaged helper is byte-identical to source. `verification.json`, `source-final.json` and `package-final-manifest.json` bind these separate proof layers.

The first browser preflight failed on a fixture-only case-insensitive `lib`/`Lib` collision; another negative run caught an overly strict test locator. Visual inspection then found a real button-style conflict, corrected with the existing class merge helper and a contrast assertion. The first process-deadline fixture expired before Python startup; its bounded allowance was corrected before testing the actual unresponsive-process termination. Earlier negative artifacts are retained.

## Grok contribution

The owner preference is persisted in `docs/GOAL-PROMPT.md`: use authenticated Grok CLI `grok-4.6 --reasoning-effort xhigh` substantially through the goal; use 4.7 only when actually listed. The latest availability check listed 4.6/4.5, not 4.7. Grok remains development tooling, not the RealBud runtime agent.

- Helper proposal `01a0c460-526b-7580-b783-7fcd77933bf6` returned `grok-4.6-build`. Codex corrected native schema and timestamp mismatches, lock integration, receipt/digest authority, stale-state handling, privacy, recovery fsync and cleanup races before testing. The generated proposal alone was not functional proof.
- Independent service/UI review `01a0c471-5b4c-7830-bf1b-c49affeefa3f` returned changes required. Its three findings were accepted: serialized reads, timeout/uncertainty handling, and ambiguous post-dispatch decision outcomes. Focused tests and actual browser checks passed after correction.
- Final bounded native recovery review `01a0c480-643b-7c41-8138-842f11b4198c` returned `grok-4.6-build`, approved with no findings. It reviewed the supplied decision/recovery functions, not every omitted utility or the whole system. Its stated limits are retained in `grok-disposition.json`. A subsequent Codex UI review added the exact digest/decision reconciliation fix and six regression cases; this is separate from native recovery approval.
- `grok-disposition.json` records accepted findings, changes and review scope. Raw hidden reasoning is not a product artifact. The fresh `grok models` receipt again lists only 4.6 and 4.5.

## Remaining work

The new Windows inbox is explicitly held. A protected profile ACL alone cannot establish privacy of existing child files with explicit grants. Per-file Windows ACL validation, durable rename and native device checks must pass before enabling this feature there. Other RealBud Windows features and their earlier release gates are separate.

Foreground ACP replacement/removal/batch callbacks still provide ambiguous prose or a substring, without a typed complete change. They remain refused by the existing inline gate. A pending inbox does not prove they are staged. Single-add conversation approval stays in Ask.

The next foreground path should reuse the existing authenticated per-session MCP broker pattern:

1. Add a proposal-only `memory-proposals` descriptor at `server/drivers/acp/core.ts`, following the browser/connected-app broker lifecycle before `session/new`.
2. Attach it before Product Ask's early return in `server/index.ts`; the later legacy agents integration is not reached by Product Ask.
3. Capture workspace/profile/runtime and active-turn identity from the host, re-enter that scope in callbacks, and never accept identity/path/key fields as tool arguments.
4. Add a host-only typed `propose` operation using the existing service/helper. Return a pending ID and review location, never approval methods or signing authority. Persist bounded retry identities and publish verified native pending bytes without overwriting an existing ID; native `stage_write` alone can report success after failure.
5. Reuse the existing screen and human decision API. Keep the ambiguous native inline callback refused. Exercise fake-ACP → actual Product Ask → broker → native pending → staff review, plus unmodified Hermes tool discovery.

This path is source-grounded planning, not implemented capability. Real Keychain/DPAPI, signed install/update/reboot, managed connector/billing commissioning, live customer Gmail/paired CSV/REI acceptance and multi-device office soak remain separate overall-goal gates.
