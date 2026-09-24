# Storage options — 24 September 2026

This read-only inventory does not authorize cleanup, relocation or VM installation. Directory sizes are not guaranteed recoverable space.

Current available space: **7.19 GiB**.
Backup export admission: **8.18424 GiB**; allow **12 GiB** for the package QA and kit sequence.
The previously proposed Windows VM workspace needs approximately **100 GB** free for Windows, updates and snapshots.

| Location | Directory size | Status |
| --- | ---: | --- |
| `/Users/yoda/projects/RealBud-platform-candidate-2026-09-23/outputs/integration-qa-2026-09-23` | 5.94 GiB | Retained packages, test kits and evidence; preserve |
| `/Users/yoda/projects/RealBud-platform-candidate-2026-09-23/outputs/platform-candidate-2026-09-23` | 4.96 GiB | Retained packages, test kits and evidence; preserve |
| `/Users/yoda/projects/RealBud-platform-candidate-2026-09-23/outputs/platform-followup-2026-09-24` | 4.66 GiB | Current and earlier package attempts and evidence; preserve |
| `/Users/yoda/.npm/_cacache` | 0.81 GiB | Regenerable npm cache; no cleanup authorized |
| `/Users/yoda/Library/Caches/pip` | 0.73 GiB | Regenerable pip cache; no cleanup authorized |

The two measured caches total **1.54 GiB**. Even recovering all of that would not reach the 12 GiB test target. No cache cleanup has been performed.

Prefer an external SSD for the VM and future build output. Retained artifacts should only be relocated after choosing a destination, copying them, verifying hashes and explicitly approving removal of the originals.

The existing storage-location question remains pending. The active uv cache and running RealBud package apps are excluded from cleanup options.
