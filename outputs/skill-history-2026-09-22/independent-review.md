# Independent instruction-history implementation review

Read-only production review; artifacts and isolated tests only. No live providers, secrets, customer data or deployment. Tests run on this macOS host using Node 24 and the repository's disposable test-home setup.

## Results

The focused independent suite passes **11 tests across 3 files** (`independent-review-final-suite.json`). The common graph, schema and actual service/private writer are exercised; these are synthetic local fixtures, not a named-device Windows acceptance run or customer workflow proof.

- **Historical digest consistency:** An older immutable batch recorded active revision 6 with digest A, while later hot history or the next batch could carry revision 6 with another internally valid digest. The original common graph admitted the contradiction. Desktop fixed backup traversal and backend mirrored it for live reads: bounded per-lineage active commitments are checked against newer batch content or current hot history. Four independent cases now pass, including a legitimate removed/reintroduced lineage that reuses revision numbers. The original red receipt was graph-only; the improved green fixtures normalize actual pack/recipe definitions and separately pass business-file admission before graph validation.
- **Near-full admission:** An already-valid 2,000,000-byte v1 journal admits its exact compact v2 archive intent. Extra normal retained bytes cannot borrow the intent allowance. Altered intents and v1 roots carrying the intent reject; pending intent blocks backup. Three independent schema/business-admission checks pass.
- **Real persistence/recovery:** Root identified the private writer's earlier hardcoded existing-destination 2MB check. Backend's scoped existing-admission fix was present before the independent service run. Three real service/file-writer checks pass: exact2MB legacy journal→completed archival→idempotent retry; scope change after durable archive file→held intent→original-scope resume; and a synthetic lost response after head publication→byte-identical completion on retry. Active native text and saved plan state remain unchanged by archival. No red test is claimed for the writer issue.

- **Archived-only downgrade gate:** The final actual-service fixture archived a skill, removed it, advanced pack configurations and archived the original configuration. Changing the saved root to v1 and removing the last archival receipt left the only skill head inside immutable configuration history. Live reads accepted it although backup correctly rejected it. The backend now requires v2 whenever any live configuration traversal discovers a skill head. The original actual-service rejection test failed; the same case now passes in the final 11-test suite. This is corrupted/downgraded journal admission, not a provider or authority escape. See `independent-live-downgrade-red.json` and the final suite receipt.

## Source review

`server/customer-packs.ts` retains archive metadata in `completedUpgrade`, binds archival/revert to reviewed scope and identities, and reads the compact-intent allowance through the same pure validator. `server/private-json.ts` now accepts an optional existing-destination admission callback; ordinary callers keep the earlier bound. `server/customer-pack-skill-backup.ts` checks every root before cache reuse and carries at most two unresolved active commitments per lineage. A prior commitment can only refer to the next batch's first two versions or current hot history, so this avoids retaining every instruction body in graph validation. Shared references and distinct reintroduced histories remain separate from cycle detection.

The tests are intentionally bounded; root owns the rendered GUI/HTTP scenarios and full suite, while the backup worker owns full encrypted v1/v2 restore integration. No fresh result from those other layers is claimed here. The v2 gate is source/schema-verified, not a run of an installed older application.

## Reproduction

From the repository root with Node 24 available:

```sh
pnpm exec vitest run --config outputs/skill-history-2026-09-22/independent-review.vitest.config.ts --reporter=json --outputFile=outputs/skill-history-2026-09-22/independent-review-suite.json
```

The original graph red evidence and subsequent green receipts are retained; tests and manifests are local review artifacts, not production code. The Grok process is terminal; its receipt and disposition are separate files in this directory.

## Grok outcome and cleanup

The one concrete-source call selected `grok-4.7` / `xhigh` and sent one 1,986-byte prompt. It timed out at the original 290-second review deadline; cleanup finished at 293.195 seconds. No final assistant answer, terminal usage or actual model bucket was returned, so no Grok advice or approval is claimed. No retry was attempted. The owned process group was reaped and independently verified empty, disposable home removed, global config hash unchanged, zero tools/permissions/MCP tools or servers observed, and no authentication contents read/copied. See `grok-skill-implementation-disposition.json` and `grok-skill-implementation-cleanup.json`.

The final local independent results are 11/11 passing after both discovered admission fixes. This review's production-code findings were handed to their existing owners and resolved; the reviewer changed only files in this output directory. Root continues the full suite, packaging and GUI evidence separately.
