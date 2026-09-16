"""Relocate the explicitly selected installed PostgreSQL for a synthetic Mac kit.

Never edits the installed formula. This is a test artifact, not admission of a
customer database runtime. Every copied binary and native dependency is hashed.
"""
from pathlib import Path
import hashlib, json, os, shutil, subprocess, sys

source = Path(sys.argv[1]).resolve()
target = Path(sys.argv[2]).resolve()
if sys.platform != 'darwin' or target.exists():
    raise SystemExit('Run on macOS with a new destination directory')
assert (source / 'bin/postgres').is_file() and (source / 'share/postgresql@16').is_dir()
target.mkdir(parents=True)
run = lambda args: subprocess.check_output(args, text=True, stderr=subprocess.STDOUT, timeout=30)
records, queued, mapped = [], [], {}

def copy_native(origin, destination):
    origin = origin.resolve()
    if mapped.get(origin) == destination:
        return
    if destination.exists():
        if hashlib.sha256(origin.read_bytes()).digest() != hashlib.sha256(destination.read_bytes()).digest():
            raise RuntimeError('Native dependency basename collision')
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(origin, destination)
    destination.chmod(destination.stat().st_mode | 0o200)
    mapped[origin] = destination
    queued.append((origin, destination))

for name in ['postgres', 'initdb', 'pg_ctl', 'createdb', 'pg_dump', 'pg_restore', 'psql']:
    copy_native(source / 'bin' / name, target / 'bin' / name)
shutil.copytree(source / 'share/postgresql@16', target / 'share/postgresql@16', symlinks=False)
for native in (source / 'lib/postgresql').glob('*.dylib'):
    copy_native(native, target / 'lib/postgresql' / native.name)

for origin, destination in queued:
    original_hash = hashlib.sha256(origin.read_bytes()).hexdigest()
    lines = run(['otool', '-L', str(origin)]).splitlines()[1:]
    for line in lines:
        dependency = line.strip().split(' (compatibility version')[0]
        if dependency.startswith(('/usr/lib/', '/System/Library/')):
            continue
        if dependency.startswith('@loader_path/'):
            dep = (origin.parent / dependency.removeprefix('@loader_path/')).resolve()
        elif dependency.startswith('/'):
            dep = Path(dependency).resolve()
        else:
            raise RuntimeError('Unresolved native dependency: ' + dependency)
        if dep == origin:
            continue
        dest = mapped.get(dep, target / 'lib' / dep.name)
        copy_native(dep, dest)
        linked = '@loader_path/' + os.path.relpath(dest, destination.parent)
        run(['install_name_tool', '-change', dependency, linked, str(destination)])
    if destination.suffix == '.dylib':
        run(['install_name_tool', '-id', '@rpath/' + destination.name, str(destination)])
    run(['codesign', '--force', '--sign', '-', str(destination)])
    records.append({'path': str(destination.relative_to(target)), 'source': str(origin),
                    'sourceSha256': original_hash, 'sha256': hashlib.sha256(destination.read_bytes()).hexdigest()})

# Preserve notices from PostgreSQL and each copied Homebrew dependency.
notices = target / 'notices'; notices.mkdir()
for origin in set([source, *[Path(row['source']).parents[1] for row in records]]):
    for name in ['COPYRIGHT', 'LICENSE', 'LICENSE.txt', 'LICENSE.md', 'COPYING', 'COPYING.LESSER']:
        file = origin / name
        if file.is_file():
            prefix = hashlib.sha256(str(file).encode()).hexdigest()[:12]
            shutil.copy2(file, notices / (prefix + '-' + name))
manifest = {'purpose': 'synthetic-test-only', 'platform': 'darwin', 'architecture': run(['uname', '-m']).strip(),
            'builtOn': run(['sw_vers', '-productVersion']).strip(),
            'version': run([str(target / 'bin/postgres'), '--version']).strip(), 'files': records,
            'nativeInstalledAcceptance': False, 'secondMacAcceptance': False}
(target / 'test-runtime-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps({'nativeFiles': len(records), 'version': manifest['version'], 'destination': str(target)}))
