# Austin phase-one packs

These are importable preparation jobs built from the expected-bills and bank-reference workflows in engagement revision 19. [workflows.json](workflows.json) uses RealBud's existing version-1 importer. The full procedure travels inside each job's description and steps; no additional skill installer or modified Hermes engine is required.

The two jobs prepare review material from supplied inputs. Bill findings do not automatically update the expected-bill register. Bank proposals do not automatically apply reference changes: the existing bank review/export flow requires exact reviewed decisions. Automated Gmail/bank acquisition and the final REI handoff remain separate integration/acceptance work.

## Import and local test

1. In a clean RealBud test office, open Schedule → Import office packs and choose `workflows.json`.
2. Review the two job cards. Import leaves approval and schedules off. Existing jobs with the same IDs and different instructions are preserved and produce a conflict; use the isolated QA office to avoid changing existing work.
3. Supply `workflow-inputs/expected-bills.json` and `workflow-inputs/bank-reference.json` inside that office's workroom. The latter is the actual bank processor's saved batch wrapped with coverage, `formatConfirmed` and a source reference. The QA script constructs both from the included synthetic fixtures.
4. Approve the preparation plans locally and run them. Inspect the full findings, held items and input reference in each result.
5. Export the workflows, import the downloaded file into a second clean office, bind that office's own inputs and approve locally. Run again and compare the decisions and actual bank output.

No schedule is included because clock times, timezone and coverage need office confirmation. The fixture's Brisbane timezone is a test input, not an accepted customer setting. The sample bank CSV is a supported synthetic format, not a verified ANZ customer layout. The test has no real customer records or account connections.

## Repeatable QA

Use Node 24 or later. From the repository root:

```sh
pnpm qa:austin-packs
pnpm qa:austin-packs --live
```

The first command checks real HTTP import/export, validation, local approvals, restart persistence, and deterministic bank review/export. It does not use a model. `--live` additionally runs the imported jobs with RealBud's connected Hermes model before and after the round trip, checks actual findings, tests missing inputs and incomplete coverage, and verifies duplicate requests reuse one run. It uses the existing RealBud-owned profile and model login; it does not copy credentials into the pack or test office.

Both commands create two isolated temporary office directories and save dated evidence under `outputs/`. Existing RealBud office records are not used. An explicit `--out <new-directory>` selects the evidence destination. Existing output directories are rejected to preserve earlier results. Servers are stopped after the run; synthetic temporary office state is retained for inspection.

Outputs include the combined `Austin-Phase1-Workflows.json`, the individual `Expected-Bills.json` and `Payment-References.json`, `Office-A-Export.json`, `Office-B-Reexport.json`, checked bank CSVs and `qa-report.json`. Live runs also retain Bud's reviews and durable run receipts. Only the clean combined/individual workflow files are candidates for customer delivery; QA receipts and test office state are internal.

## Evidence required before handover

The harness compares the exact procedure fields across import/export, not timestamps or local approvals. Each model run must echo an unpredictable reference from the actual input file. Expected bill outcomes and bank decisions have fixed synthetic answers. Bank output is checked byte for byte: only the explicitly reviewed reference can differ, while ambiguous and duplicate rows remain present.

The bank review in this harness is a simulated human reviewer calling the real app API. It does not establish an automatic link from a model proposal to the review UI. Source API tests do not establish packaged-app, Windows, real-site acquisition or Austin acceptance; record those separately.
