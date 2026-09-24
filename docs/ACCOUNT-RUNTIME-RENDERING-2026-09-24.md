# Account pages resolve authentication at runtime

Local canonical adoption only, 24 September 2026. This checkpoint does not establish deployment, hosted sign-in, payment or installed-device acceptance.

A production build made without authentication credentials could permanently prerender the account-unconfigured fallback. Supplying valid authentication at runtime did not replace it because the pages returned before consulting the session. The verified correction adds only `export const dynamic = "force-dynamic"` to the account overview, service invoices, limits, rates and support pages. The usage redirect remains static. The regression script `website/scripts/qa-account-runtime-auth.mjs` is a byte-identical copy of the isolated candidate's script; it uses fictional local identity, real disposable PostgreSQL and actual production Next pages.

## Preserved baseline and exact delta

The frozen 26-file usage/payment manifest remains unchanged at `outputs/modelvia-usage-payment-2026-09-23/source-manifest.json` (SHA256 `a72f3f0bd5dbd49716dc90c3e17874fbbc4d5b6141cf4b8bbcfbcc37336c78dd`). The five-page patch is recorded separately in `outputs/account-runtime-rendering-2026-09-24/account-runtime-rendering.patch` (SHA256 `12d1a75e4ba883dbdd6b0cc6a8e89e1ef54594dd4476bfced0a832b7641d267c`). Apply that delta after the frozen usage/payment source snapshot; do not replace the earlier manifest or pretend its overview hash describes the new page.

Root verified all five resulting page hashes against the candidate. Removing each added declaration reproduces its exact previous hash, preserving the overview's existing usage UI. The other 25 files in the frozen manifest are unchanged. The explicit before/after hashes, new regression hash and unchanged usage-redirect hash are in `outputs/account-runtime-rendering-2026-09-24/source-delta.json`.

## Canonical verification

The credentials-free production build passes as `FGiQlgQpRthGz3xY2QJ-f`, with external network denied. Root independently inspected its prerender manifest: all five account pages are dynamic; `/account/usage` remains static. Scoped lint and diff checks pass.

On that same build, runtime authentication verifies **5 / 0 / 0** signed-in page checks and **10 / 0 / 0** missing/malformed-session redirects (passed / failed / skipped). Every protected response has private/no-store caching. Actual rendered pages fit 360 px, show their expected authenticated content, and make no external browser requests or business-form submissions. Seven real disposable PostgreSQL identity RPCs complete without auth, route or database violations. Root checked all receipt source hashes and visually inspected the canonical 360 px overview.

The first canonical browser attempt failed before page checks while starting disposable PostgreSQL. Independent probes reproduced both a denied Unix-domain socket and a socket path over macOS's 103-byte limit. The QA-only retry used short `/tmp` scratch and allowed Unix/loopback sockets while continuing to deny external network; no product source or regression assertions changed, and the successful build was reused. The failed receipt and diagnostic evidence remain preserved. Environment files were restored; no held environment files remain. Successful test processes and scratch were cleaned up.

Final proof: `outputs/account-runtime-rendering-2026-09-24/verification.json`, with its exact run receipts and logs. The candidate's separate 152-unit and 29-group/71-render billing verification remains source-specific evidence from its owner; it is not relabelled as a new canonical run in this checkpoint. Earlier live-account, native-device and customer-acceptance gates remain open.
