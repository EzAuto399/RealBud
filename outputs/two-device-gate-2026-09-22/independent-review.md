# Independent two-device receipt gate review — 22 September 2026

This review uses fictional temporary evidence only. It does not operate installed devices or establish Windows, macOS, office, customer or release acceptance. Production files are owned and edited by the parent; this review writes only this output directory.

## Baseline findings reproduced

`independent-probes.mjs` runs against the preserved `before/scripts/check-two-device-acceptance.mjs`; `independent-baseline-probes.json` preserves outcomes.

1. A numeric workflow ID throws at `r?.id?.startsWith(...)` instead of producing validation issues. Null, number, string, object and array entries across device, workflow and operational-check lists otherwise failed closed without throwing in this probe.
2. Participant coverage is incomplete: `['A', 'B', 'B', 'outside']` passes the designated both-member case and empty participants pass all undesignated cases. The complete source-backed participant policy and strict valid/unique slot validation are required.
3. `checkEvidence` accepts a supplied contract with zero case IDs and a receipt with no case observations. The exported validator needs an admitted immutable contract or equivalent validation, not only a stricter file loader.
4. Deterministic replacement of an evidence file by a symlink after its pathname stat but before pathname read causes the first evidence check to read and accept synthetic outside bytes. Later evidence checks reject the now-escaping path, so this particular multi-reference receipt still fails overall. The demonstrated defect is the unintended outside read, not a claim that the whole receipt passes. Verify descriptor identity/size and path confinement across the read, with bounded reads rather than an unbounded pathname read.

The preserved baseline test fixture has 71 IDs, four platform pairings and six independent runs. It is a structural fixture and does not purport to recover historical participant policy.

## Interrupted Grok review

The existing ACP call selected `grok-4.7` with `xhigh` and sent one prompt. The persisted receipt contains no final assistant text, terminal result, completion or timeout. Its process and collector were absent when independently checked. Therefore this was an interrupted incomplete review; no Grok findings or actual completed model execution are claimed. The call was not restarted.

`grok-two-device-cleanup.json` records no remaining matching process, removal of the abandoned disposable home, unchanged global configuration hash and no reading/copying of authentication contents. The original partial `grok-two-device-acp-run.json` remains unchanged.

## Final implementation review

The frozen candidate was independently read and exercised through `independent-final-probes.json`. All prior reproduced defects now fail closed. A new valid-JSON malformed Windows version (`{"toString":null}`) found during candidate review was fixed by a string type guard and regression coverage; the final direct probe denies it without throwing.

The final probe includes a positive synthetic receipt, rejection of a reused result receipt across separate jobs, malformed list values and workflow IDs, full participant validation, explicit rejection of a caller-created shortened contract, and 360 scalar JSON mutation checks with no unexpected throw. The deterministic stat-to-read symlink substitution now continues reading the originally opened safe descriptor: the foreign digest fails, and later outside-path references are denied. The parent separately owns the before-read path replacement regression. No installed device was exercised.

`independent-final-source-fingerprints.json` binds the reviewed checker/tests/contract/catalogue/policy documentation. Those hashes were rechecked after final probes. Source review confirms all 71 case IDs and six workflow mappings remain required; no complete application test suite was rerun by this reviewer. No further concrete blocking findings remain for this tooling repair. Broader device and customer proof remains outstanding as documented by the policy.
