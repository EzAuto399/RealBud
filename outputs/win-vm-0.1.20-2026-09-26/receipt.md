# Windows 11 Arm VM: RealBud 0.1.20 from main 77c3aa1d (26 September 2026)

Stopped at the Windows lock screen. The only guest input was a single Ctrl key to wake the display.

- Build: Package Windows run 36203618904, head 77c3aa1d8500c00437c48857755e4e7c8758295b. Both jobs succeeded.
- Download location: `~/RealBud-candidates/main-77c3aa1d-win-ci-36203618904/`.
- Installer `RealBud-0.1.20-setup.exe`: 166,051,553 bytes.
  - SHA-512 (base64) matches the run's latest.yml: ROlpE2VO…JCxPA==
  - SHA-256 8a0dcabd60b01f30833f6b6a144d40793cb6b138a91f9e42ed3da1b33fccc8d5, which matches installed-lifecycle.json (passed:true).
- Media: `/Volumes/RealBud-TestLab/downloads/RealBud-77c3aa1d-test-media.iso`, SHA-256 754130bc1d1b91a2add0d6f8d780d5f0e200a6eea434e57c756fdd3812ed1dac. Read-only extraction gives installer SHA-256 8a0dcabd…8bc6.
- Swapped onto SATA port 1 at about 00:39Z (storageattach exit 0). SATA port 0 is the unchanged VM disk.
- Guest at 00:40Z: locked at the `realbudqa` password prompt (shots/01-state.png). Guest hash, upgrade, launch, backup and fix checks: not run.
