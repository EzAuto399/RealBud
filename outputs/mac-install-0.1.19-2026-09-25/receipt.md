# macOS upgrade 0.1.18 → 0.1.19 on the build Mac — 25 September 2026

Owner chose "Upgrade the real app" in chat.

- Backup before upgrade: `/Volumes/RealBud-TestLab/backups/mac-pre-0.1.19-20260925-191717/` (`~/.realbud` 5.3 GB, verified identical with `diff -rq`; `~/Library/Application Support/RealBud`; the 0.1.18 app bundle).
- Installed from `RealBud-0.1.19.dmg`, SHA-256 `ec0767583494c228143dd804f091b6acc7197615d48c6f020e337e64962f1077` (matches `outputs/mac-candidate-5d162956-2026-09-25/receipt.md`). `codesign --verify --deep --strict` valid. Not notarized; no quarantine attribute on the copied app.
- Launch: app window and detached office service started (service port 8799). `GET /api/health` → 200 `{"app":"realbud",...}`.
- Window: `01-launch.png` (window region only) shows the welcome screen "Make the desk yours", 1 of 2. The 24 September checkpoint recorded 0.1.18 also at fresh welcome, so this is not a regression signal.
- Data: `desk.json` rewritten on launch; its structure (keys and collection sizes, depth 3) is unchanged against the backup. An empty `onboarding/` folder was created.

Not run: onboarding, close/reopen persistence, sample desk, backup/restore, Bud, browser connection, linking. Tier: installed device (owner's Mac), not customer acceptance.
