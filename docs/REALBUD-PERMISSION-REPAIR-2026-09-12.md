**RealBud permission repair — installed and verified**

After the owner authorised the repair, the signed build was installed at 21:12 on 12 September. The installed app now recognises both existing permissions, starts its embedded computer helper, retains the DeepSeek connection and answers through native Ask. [Installation and verification receipt](/Users/yoda/projects/PropertyMe/outputs/realbud-validation-2026-09-12/permission-install-receipt.json).

The switches were enabled correctly. macOS rejected the running app because its signing identity did not match the identity attached to those permissions.

At 20:39:28 on 12 September, TCC logged “Failed to match existing code requirement” for both Accessibility and ScreenCapture, attributed to RealBud PID 11899. Its saved requirement names `com.realbud.app` with Developer ID team `4F4SMS88P8`. The installed copy instead carries an ad-hoc signature, no team, and CDHash `06103699babb1d731737841e38190edb627db371`. Its resources were also modified after signing. Restarting does not restore that identity.

The [exact diagnosis](/Users/yoda/projects/PropertyMe/outputs/realbud-validation-2026-09-12/permission-root-cause.json) and [filtered macOS log](/Users/yoda/projects/PropertyMe/outputs/realbud-validation-2026-09-12/tcc-realbud.log) preserve the evidence. No TCC database, permission switch, credential or security protection was changed during this repair preparation.

I rebuilt the current tested source as RealBud 0.1.18 using the repository's existing build, native-helper and electron-builder pipeline, with Developer ID signing required and publishing disabled. The staged binary is:

`/Users/yoda/projects/PropertyMe/outputs/realbud-validation-2026-09-12/permission-repair/mac-arm64/RealBud.app`

| Verification | Result |
|---|---|
| Frontend/server/updater build and native helpers | Passed |
| Whole-bundle deep/strict code signature | Passed |
| Exact TCC Developer ID requirement | Passed |
| Packaged startup with temporary isolated data | Passed |
| Native local-computer capability | **Available**, from the packaged app's actual capability response |
| Renderer and private service | Passed, separate test port 18799 |
| Clean quit and service termination | Passed |
| Existing installed app | Replaced after owner approval; signature and candidate hashes reverified |
| Installed native permission checks | TCC grants Accessibility and ScreenCapture (`authValue: 2`) for main PID 43690 |
| Installed model/Ask | DeepSeek ready; native Ask correctly answered 37 + 8 = 45 |
| Real selected-tab read / capability containment | Still a separate, incomplete acceptance gate |
| Publication, updater promotion and notarization | Not performed |

The [signature/identity receipt](/Users/yoda/projects/PropertyMe/outputs/realbud-validation-2026-09-12/permission-repair-verification.json) includes artifact hashes. The [packaged smoke result](/Users/yoda/projects/PropertyMe/outputs/realbud-validation-2026-09-12/permission-repair-smoke-result.json) reports `localComputer.available: true`. Its descriptor was correctly set to `desktop-host-stopped` on exit. This is evidence that the replacement recognises the existing permission grant; it is not a browser operation or customer acceptance claim.

Installation replaced only `/Applications/RealBud.app`. The old app is retained at `/Users/yoda/projects/PropertyMe/outputs/realbud-validation-2026-09-12/installed-backup-20260912-211257/RealBud.app`. The installer left `.realbud` and Application Support data in place; the five selected saved-data/model-profile files checked before and after replacement were byte-identical. Prior Ask history and the stopped turn were visible after relaunch. The old app's quit bug left its idle main process alive, so only that identified process was terminated before the bundle switch. No old writable databases were restored.

At 21:13:34, TCC recorded successful Accessibility (`43690.2`) and ScreenCapture (`43690.3`) checks for the newly installed main process. The descriptor now reports `embedded`, the private service runs as PID 43701 on port 8799, and the owned model still resolves to `.realbud/hermes/profiles/property`. The successful native Ask response was observed at 21:14. The installation is authorised by the owner's subsequent “fix it then”; no further deployment approval is pending for this completed replacement.

The OS log also contains a separate AppleEvents entitlement warning involving the app and system UI helpers. No AppleEvents permission or entitlement was added during this repair, and no browser action was used to prove or dismiss that warning. The selected-browser execution and broker-containment gates remain unverified; fixing the two permission checks does not close those broader gates.

Do not hot-patch signed application resources or replace the app's Developer ID signature with ad-hoc signing. Source changes should go through a complete signed package so permission identity and bundle integrity remain consistent.
