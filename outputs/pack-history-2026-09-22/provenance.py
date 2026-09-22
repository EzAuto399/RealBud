from pathlib import Path
import hashlib, json, os, sys
root=Path('/Users/yoda/projects/RealBud')
out=root/'outputs/pack-history-2026-09-22'
def digest_file(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda:f.read(1024*1024),b''): h.update(chunk)
    return h.hexdigest()
def collect(base, starts):
    paths=[]
    for start in starts:
        candidate=base/start
        if candidate.is_file(): paths.append(candidate); continue
        for folder,dirs,files in os.walk(candidate,followlinks=False):
            dirs[:]=[d for d in dirs if d not in ['node_modules','__pycache__']]
            for name in dirs+files:
                path=Path(folder)/name
                if path.is_symlink() or (path.is_file() and path.suffix!='.pyc' and path.name!='.DS_Store'): paths.append(path)
    files={}
    for path in sorted(set(paths)):
        files[str(path.relative_to(base))]={'symlink':os.readlink(path)} if path.is_symlink() else {'sha256':digest_file(path),'bytes':path.stat().st_size}
    return {'files':files,'digest':hashlib.sha256(json.dumps(files,sort_keys=True,separators=(',',':')).encode()).hexdigest()}
mode=sys.argv[1]
if mode=='source':
    value=collect(root,['server','shared','src','electron','scripts','pack','.github','package.json','pnpm-lock.yaml','electron-builder.yml','vite.config.ts','tsconfig.json','tsconfig.server.json','tsconfig.server.build.json'])
else:
    base=root/'outputs/pack-history-2026-09-22/package/mac-arm64/RealBud.app'
    value=collect(base,['.'])
name=sys.argv[2]
(out/name).write_text(json.dumps(value,indent=2)+'\n')
print(json.dumps({'manifest':name,'entries':len(value['files']),'digest':value['digest']}))
