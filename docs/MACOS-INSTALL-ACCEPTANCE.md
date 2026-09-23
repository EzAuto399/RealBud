# macOS installed-app acceptance

Use the supplied **Apple Silicon** candidate with fictional data in a separate
macOS test account. Record the artifact filename, SHA256, source revision from
its receipt, macOS version, and pass / fail / blocked / not run for each step.
The packaged-app checks in [the current candidate](PLATFORM-CANDIDATE-2026-09-23.md)
do not establish acceptance on another Mac.

1. **Verify and install — allow 5 minutes.** Compare `shasum -a 256` for the
   supplied DMG with its receipt. Confirm whether that exact artifact is
   notarized. If notarization remains blocked, record the distribution check
   as blocked; do not disable Gatekeeper or remove quarantine. On a normal
   downloaded, notarized artifact, install and open through Finder and record
   the result. Customers do not need Node, pnpm or Xcode to launch the app.

2. **Check launch and saved work — allow 5 minutes.** Complete onboarding,
   create a fictional record, quit, and reopen. Check the same workspace,
   record and navigation return. Check tray/window reopening does not create
   duplicate work. Do not replace an existing personal installation to run
   this acceptance check.

3. **Check setup and permissions — allow 15 minutes.** Run normal worker
   setup; cancel and retry through its controls. Check denial and grant flows
   for microphone, Accessibility and Screen Recording in normal System
   Settings. Use a fictional spoken phrase. Record account linking or model
   turns as blocked unless separate QA access and spending are authorized.

4. **Check browser control and handoff — allow 15 minutes.** Use a separate
   browser test profile and fictional page. Grant a scoped task, press Stop,
   and verify automated input ends. Request human sign-in handoff and verify
   the app releases control. Resume only through the explicit return flow.
   Personal sessions, MFA and real sends require separate authorized checks.

5. **Check backup and upgrade — allow 15 minutes.** Export an encrypted
   fictional backup, restore into a fresh test workspace, reopen, and compare
   records and original files. Confirm schedules remain disabled. If an
   identified supported older installer is supplied, test its upgrade with a
   retained backup; otherwise mark upgrade not run. Two-computer office joining
   and real customer workflows require their own acceptance records.

Build/signing preparation is documented in [the release guide](GRADUATE-RELEASE.md).
