# Mac QA handoff

Use `launch-qa.command` in this folder after `final-candidate-result.json` reports `passed: true`. It opens the signed local candidate in its own QA folder. It does not replace `/Applications/RealBud.app` or reuse the main workspace's data. Notarization and fresh-machine acceptance remain open.

1. Open the launcher and finish the private workspace setup. Under **You → Website account**, link the intended signed-in RealBud website account. Confirm installation model access and run the readiness check. Genuine account linking remains the next live gate; the automated app harness used a fictional website.
2. Export a small CBA date range yourself, then run **bank → CSV**. Compare row count, dates, signed amounts, references and totals with the original. Keep the raw export private. ANZ and REI upload are not proved by this run; REI is out of current scope.
3. Use fictional email for **bills → calendar** and **morning priorities** first. Confirm source identity, timezone, missing-source notices and staff approval. PDF reading is locally implemented for one text-based PDF up to 2 MB/20 pages; live managed Gmail needs the new connector endpoint released first. Scanned or multiple PDFs require manual review.
4. Check failed/expired access, a second readiness check and Stop on a disposable task. Read the saved activity/usage before retrying an uncertain request. The local tests leave uncertain costs held rather than pretending cancellation proved zero spend.
5. Review the second-office/department and local-join flow on disposable data. A same-laptop simulation is separate from the still-open native Windows and two-computer office acceptance.

Detailed evidence and remaining gates: `docs/READINESS-GAPS-2026-09-23.md` in the repository. No bank login, real mail read, payment or external calendar write was performed by the automated tests in this checkpoint.
