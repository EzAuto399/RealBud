# Windows primitive acceptance harness review disposition, final v2

This supersedes `acceptance-review-disposition.md` and `acceptance-final-verification.json` after the root review additions below. Earlier evidence remains historical and unchanged.

Grok CLI accepted `--model grok-4.7 --reasoning-effort xhigh` and returned one `grok-4.7-build` model call, exit 0 / `end_turn`, session `01a0c4cd-9707-77f3-ac85-5add7c736758`, after 831.89 seconds. The call had one turn, no tools, no web search and no subagents. Its source-only verdict was **changes-required**, with four actionable harness findings. This is a terminal review result, not native Windows validation or approval of subsequent edits.

The frozen prompt SHA-256 is `b24026dde6e13799b4beb51f6963217c8cbc9669091a45adde5487aed7ddfbc5`. Frozen inputs remain in `acceptance-grok-review-inputs.json`; the prompt and structured result remain unchanged. Final observed harness SHA-256: `27934423fd6ed25c4700807d6dc044a054848f55e9914de3f35cac90bc92b0aa`. Current observed backend SHA-256: `b3a9d5bb67b5c2cc2f920b046b1472044204bc872ebef8113cf13d19d8e86213`; the backend is owned by another agent and was not edited by this harness task.

## Finding disposition

| Finding | Source resolution | Verification boundary |
| --- | --- | --- |
| Hard-link cleanup while a backend handle excludes delete sharing | Close the seed handle before creating the alias; require two links on both names, refuse both native opens, preserve bytes, unlink with no native handles held, then reopen and compare original identity and bytes. | Source inspection only; actual Windows sharing behavior requires the native run. |
| Junction refusal could pass after following the target | Require the fixed `unsafe-storage` category. A `conflict` from final-path mismatch no longer passes. Preserve target bytes and remove only the owned junction. | Source inspection only; real junction refusal remains unexecuted. |
| Inherited-child test did not prove containment | Add an unrelated protected sibling root; require refusal both before and after successful binding to the containing root. Compare unchanged SDDL and bytes. | Source inspection only; actual DACL and root checks require Windows. |
| Cleanup failure masked a primary check failure | Keep status `failed` when already failed; record cleanup failure separately. Only otherwise use `cleanup-failed`. | Source inspection and Python syntax only. |

## Changes after the frozen review packet

The final harness contains 12 required checks. Beyond the four finding fixes, renamed stages now reopen writable and require checked flush before and after successful publication/replacement. Added exact-handle deletion with sibling identity/byte preservation, and a pre-existing independent reader with `FILE_SHARE_DELETE` that remains readable after the delete-capable handle closes, followed by absence after the final reader closes. These checks establish primitive boundaries only; a deletion request never claims journal completion or power-loss durability. The module loader also suppresses bytecode writes beside selected installed inputs.

No second model call was made. These post-packet changes were locally inspected and syntax checked; they were not included in the frozen Grok review and have not run natively on Windows.

## Actual local verification

Python 3.14.4 `ast.parse` passed without backend import. Running the final harness on macOS with a nonexistent selected-module sentinel returned **exit 2**, `unsupported`, `passed: false`, zero checks, `native_validation: false`, and cleanup true. See `acceptance-macos-final-v2-unsupported.json` and `acceptance-final-v2-verification.json`. Earlier dated receipts are preserved rather than overwritten.

Run on the exact Windows installation to obtain native evidence:

```text
python scripts/testing/hermes-memory-windows-native.py --module <exact installed or source hermes-memory-windows-native.py> --receipt <fresh receipt.json>
```

The chosen helper has no source fallback. A future native pass will still not establish complete ancestor pinning, portable protocol/journal recovery, packaged application/GUI behavior, a Windows 11 device result, power-loss safety, Hermes/provider behavior, or customer acceptance. Production Windows holds remain unchanged.

## Final root review additions

Both terminal post-delete probes now use `path.stat()` and accept only `FileNotFoundError.winerror == 2` (`ERROR_FILE_NOT_FOUND`). A missing parent, permissions failure, other inaccessible state or unspecified error cannot count as successful deletion. The native open refusal remains a supplemental assertion rather than the absence oracle.

If an independent reader body fails and `CloseHandle` also fails, the original exception is preserved and a fixed cleanup marker is attached. The receipt records this supplemental failure and reports cleanup incomplete. A close failure with a successful body becomes its own marked acceptance failure.

Seven portable control-flow checks passed with explicit fake kernel functions: exact missing-file acceptance, alternate error refusal, permission propagation, existing-name refusal, primary exception identity preservation on close failure, standalone close failure, and successful close. These checks do not call Windows or the native backend. Their exact source hash is recorded in `acceptance-portable-control-checks.json`. Syntax passed again; the final v2 macOS guard returned unsupported exit 2 with zero native checks. No additional Grok call was made.
