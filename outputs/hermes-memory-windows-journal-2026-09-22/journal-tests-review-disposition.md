# Portable Windows journal integration verification

The final suite passed **25/25 tests**, zero failures/errors/skips, in 5.702 seconds. The helper and admitted Hermes source hashes were unchanged during the run. Final syntax inspection passed. The current source hashes still match the final receipt. The tested harness SHA-256 is `e4da997285187d44b30cbf9ed12ecfda34a7bace9936eff63b82758a64a645dd`.

The tests execute the actual owned review/proposal journals, native Hermes parser, and native dry-run mutations in isolated runtime-venv child processes. An explicit fake Windows IO facade persists only fictional POSIX fixture files. Hard fault checkpoints terminate the child process and fresh processes replay the real journals. Direct native `MemoryStore._write_file`, POSIX link/rename/replace/unlink/scandir, and helper `_open_nofollow` fallback are forbidden while selected IO is active.

Coverage includes propose/list/preview/approve/reject exact replay; before/after stage publication and proposal receipts; missing, colliding and changed stage/destination preservation; unsigned-stage refusal; signed human review before proposal journal completion; approval intent/memory/final-receipt crash recovery with exactly one memory write; deletion-requested versus observed namespace cleanup; changed claim/current-memory preservation; unknown input fields; and public/direct Windows platform holds. The fake facade requires exact review and memory lock paths and one-level directory creation. Request-bound IO is checked for cleanup after successful and failed dispatch.

The first run had one harness expectation mismatch: unknown payload fields use the existing `unsupported` category, while unknown top-level request fields use `invalid`. The exact assertion was corrected after source inspection. No production change was needed for that finding. A subsequent proposal hardening change was included in the final full run. Historical failing and earlier passing receipts are preserved.

## Independent review outcome

One authenticated Grok CLI call requested `grok-4.7` with `xhigh`, a frozen **7,005-byte** selected-excerpt packet, one turn, no tools, no web search and no subagents. The fixed 600-second timeout fired at **600.05 seconds**; the process group was terminated and reaped, with Grok exit **-15**. No structured output or returned-model metadata was available. The wrapper completed cleanup, which must not be mistaken for a successful model review. No findings, approval or actual served-model claim can be drawn from this attempt. No retry was made.

The frozen prompt SHA-256 is `77534fc8b70843323494eb2cb6c0c3abf66c8cd030b5a984e30a08cd11030040` and its harness snapshot hash is `dcebd7aeb26ecc0aef30fd9dbb911869c6f131bab9a6df612540c595b3880696`. The final harness added stricter IO guards, explicit storage error mapping, exact schema categories and lock/parent assertions after that snapshot; those changes were locally inspected and tested. They were not included in a completed independent model review.

## Evidence and next execution

- `journal-tests-final.json`: terminal 25-test receipt with source/runtime hashes.
- `journal-tests-final-verification.json`: test inventory, current hashes, final source changes and review disposition.
- `journal-tests-grok-run.json`: terminal bounded review timeout receipt.
- `journal-tests-grok-inputs.json` and `journal-tests-grok-review.prompt.md`: frozen bounded review inputs.

```text
python3 scripts/testing/hermes-memory-windows-journal.py --runtime <explicit admitted hermes-agent directory> --receipt <fresh receipt.json>
```

This is **portable domain/journal evidence, not Windows evidence**. The production `WindowsJournalIO`, `WindowsMemoryStorage` and native backend are substituted, not executed. The suite proves no WinAPI, ACL, sharing, native lock interoperability, concurrent-writer safety, power-loss durability, installed application, GUI, provider or customer behavior. The public Windows admission holds remain unchanged. Actual Windows runner/device and complete facade/backend integration gates remain separate.
