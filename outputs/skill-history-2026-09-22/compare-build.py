from pathlib import Path
import hashlib,json
root=Path('/Users/yoda/projects/RealBud');out=root/'outputs/skill-history-2026-09-22';resources=out/'package/mac-arm64/RealBud.app/Contents/Resources'
results={}
for label,source,target in [('server',root/'dist-server/server',resources/'server'),('shared',root/'dist-server/shared',resources/'shared'),('support',root/'dist-server/src',resources/'src'),('renderer',root/'dist',resources/'ui'),('hermesPack',root/'pack/property',resources/'pack/property')]:
 files=[p for p in source.rglob('*') if p.is_file()]
 mismatches=[]
 for p in files:
  candidate=target/p.relative_to(source)
  if not candidate.is_file() or hashlib.sha256(p.read_bytes()).digest()!=hashlib.sha256(candidate.read_bytes()).digest():mismatches.append(str(p.relative_to(source)))
 extra=[str(p.relative_to(target)) for p in target.rglob('*') if p.is_file() and not (source/p.relative_to(target)).is_file()]
 results[label]={'checked':len(files),'mismatches':mismatches,'extraPackagedFiles':extra}
 assert not mismatches and not extra,(label,mismatches,extra)
(out/'build-comparison.json').write_text(json.dumps(results,indent=2)+'\n');print(json.dumps(results))
