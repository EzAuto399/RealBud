# Packaged native onboarding/restart QA — automation gate

Final package tested: `outputs/broad-qa-2026-09-23/package/mac-arm64/RealBud.app`.

**Native onboarding/restart is not proven.** Two bounded attempts reached packaged service adoption but failed in the automation harness before any visible onboarding assertions. No product defect was reproduced, and no product source was changed.

1. `onboarding-restart/receipt.json`: Playwright Electron main-process evaluation failed with `Resulting promise was garbage collected`.
2. `onboarding-restart-attempt-2/receipt.json`: direct packaged launch reached loopback debugger endpoints; Node inspector dynamic import failed with `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`. The Electron log also shows our resolver guard denied numeric loopback because the rule excluded `localhost` but omitted `127.0.0.1`; renderer reported `ERR_NAME_NOT_RESOLVED`.
3. `cleanup-confirmed.json`: both owned Electron processes exited after held-child cleanup; both services stopped through authenticated identity-bound control; refusing proxies closed; exact-fixture process checks found none and synthetic scratch directories were removed. Earlier failure receipts remain unchanged.
4. `electron-path-probe.json`: neutral Electron43.4.0 proved `--user-data-dir` applies before and after readiness. This is isolation evidence, not product onboarding proof. Resolving the Electron package unexpectedly downloaded its missing development binary; parent was informed and authorized proceeding with the resulting explicit path. No further helper downloads were invoked.
5. The runner remains diagnostic output, **not a passing reusable harness**. Any follow-up must use a new receipt directory, correct the loopback resolver rule, and avoid relying on the unsupported main-process bridge. Keep rendered onboarding, profile, persisted scoped stage, same-service relaunch and changed-port retention assertions intact.

No screenshots were produced because onboarding was never reached. No provider/model turn, TCC request, real profile, customer, bank, Gmail, Modelvia, REI or Windows action was performed. A generated ephemeral fixture key and prestarted packaged service avoided OS-Keychain access. Root's separate signed package smoke and the five passed browser workflow receipts remain independent evidence.
