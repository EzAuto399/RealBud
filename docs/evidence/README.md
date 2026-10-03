# Portable evidence index

[3 October 2026 checkpoints](2026-10-03-checkpoints.json) records the scope, counts, limitations and SHA-256 hashes of four dated checkpoints and the final integrated verification: runtime QA, department configuration, Schedule interaction organization autoconnection, and the MacBook handoff.

These are dated observations. They do not certify later source changes, clear a previously recorded release hold, or establish enterprise or customer acceptance. Test gates overlap; their counts must not be added as unique coverage. Source-rendered fixtures, review-package checks, live service readiness and fictional workflow simulations are identified separately.

Raw reports, logs, screenshots, transcripts and live account state remain local under `outputs/`. The manifest's `localPath` entries identify those original files; they are not portable links or a promise that raw evidence is included in a clone. Earlier documents referencing `outputs/` also describe local evidence. This index retains only selected non-sensitive metadata, not customer records, credentials, account identifiers or machine-specific paths.

To verify the recorded source hashes in the originating workspace, run from the repository root:

```sh
python3 - <<'PY'
import hashlib, json
from pathlib import Path
record = json.loads(Path('docs/evidence/2026-10-03-checkpoints.json').read_text())
for source in record['sources']:
    path = Path(source['localPath'])
    status = 'local evidence unavailable'
    if path.is_file():
        status = 'matches' if hashlib.sha256(path.read_bytes()).hexdigest() == source['sha256'] else 'changed'
    print(f'{status}: {path}')
PY
```

A matching hash identifies the recorded file bytes; it does not independently verify the claim or prove the current source tree was tested. Add a separately scoped checkpoint when new verification finishes instead of relabelling historical results.
