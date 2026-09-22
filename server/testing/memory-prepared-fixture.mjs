// Test-only crash at durable preparation, using the selected real helper.
// Callers must supply a disposable fictional profile and signing key. Nothing
// from the request or child diagnostics is printed or persisted by this helper.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const child = `import importlib.util,json,os,sys
from pathlib import Path
helper=sys.argv.pop(1)
spec=importlib.util.spec_from_file_location('realbud_prepared_fixture',helper)
review=importlib.util.module_from_spec(spec)
sys.modules[spec.name]=review
spec.loader.exec_module(review)
original=review._atomic_write
def interrupted(profile,path,data,*args,**kwargs):
    result=original(profile,path,data,*args,**kwargs)
    target=Path(path)
    if target.parent.name=='proposals' and target.suffix=='.json' and json.loads(data).get('state')=='prepared':
        os._exit(81)
    return result
review._atomic_write=interrupted
raise SystemExit(review.main())
`;

export function prepareInterruptedMemoryFixture({ python, helperPath, request }) {
  assert.equal(request.command, 'propose');
  const directory = join(request.profileDirectory, '.realbud-memory-reviews', 'proposals');
  let before = [];
  try { before = readdirSync(directory); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const result = spawnSync(python, ['-I', '-B', '-c', child, helperPath], {
    input: JSON.stringify(request), encoding: 'utf8', timeout: 20000, maxBuffer: 16384,
    env: { PATH: dirname(python), HOME: request.profileDirectory, HERMES_HOME: request.profileDirectory, LANG: 'C', LC_ALL: 'C' },
  });
  assert.equal(result.error, undefined, 'The owned preparation child must finish within its deadline.');
  assert.equal(result.status, 81, 'The actual helper must reach the durable preparation checkpoint.');
  const names = readdirSync(directory).filter(name => !before.includes(name));
  assert.equal(names.length, 1, 'Preparation must create exactly one journal and no payload stage.');
  assert.match(names[0], /^[a-f0-9]{64}\.json$/);
  return names[0].slice(0, -5);
}
