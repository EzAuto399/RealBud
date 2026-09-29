# macOS candidate from main 5d162956 — 25 September 2026

- Source: main 5d162956 (clean worktree `rb-mac-build`), Node 24.19.0, pnpm 10.33.0.
- Build: `pnpm package:mac`, exit 0, 503 s.
- `RealBud-0.1.19.dmg`: 292,911,793 bytes, SHA-256 `ec0767583494c228143dd804f091b6acc7197615d48c6f020e337e64962f1077`
- `RealBud-0.1.19-arm64.zip`: 292,138,073 bytes, SHA-256 `cddf51942662b6fba5ccbf1d2e7b6ab592092646d0f803f801b93fe14fa4a981`
- Signing: Developer ID Application (team 4F4SMS88P8), timestamped, hardened runtime; `codesign --verify --deep --strict` valid.
- Notarization: none. Gatekeeper rejects as "Unnotarized Developer ID"; no stapled ticket.
- `pnpm smoke:mac`: exit 0. It checked 69 bundled binary targets against macOS 13.0, then passed: renderer, capabilities, embedded harness, shutdown. First attempt failed only because two old QA apps held ports 8799/18799; they were quit and the smoke rerun.
- Copy: `/Volumes/RealBud-TestLab/candidates/main-5d162956-mac/RealBud-0.1.19.dmg` (SHA-256 verified).

Tier: packaged build on the build Mac. Not notarized, not installed-device acceptance.
