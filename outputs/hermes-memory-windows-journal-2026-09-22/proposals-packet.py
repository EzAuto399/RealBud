from pathlib import Path
import ast,json,hashlib,datetime
out=Path(__file__).resolve().parent
path=Path('server/helpers/hermes-memory-proposals.py');src=path.read_text();tree=ast.parse(src);lines=src.splitlines(keepends=True)
def fn(name):
 n=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name==name)
 return ''.join(lines[n.lineno-1:n.end_lineno])
header='''Review these Windows proposal transitions for concrete defects only. No tools/web/subagents, one turn; no edits or reasoning traces. Production hold stays. Host lock serializes cooperative writers. Request-selected IO is scoped/private/bounded, fixed-error; move_new is no-clobber HANDLE rename; write_new exclusive. Review read/write/flush/ensure wrappers use IO; _path_exists treats only exact missing as absent. Signed v1 journal/HMAC binds workspace/profile/runtime/scope/request key+digest/pending digest. Journal/receipt readers return None or verified data or _bad. Both intent/final human receipts prevent restaging. Both-missing prepared intentionally stays held. Published replay rejects any Windows stage and checks exact request/pending. Count uses IO.names; require_stage reads bounded exact digest. POSIX suffixes unchanged. No release claim.\n'''
parts=[('_write_stage Windows prefix',fn('_write_stage').split('    existing = _lstat_opt',1)[0]),('_publish_new',fn('_publish_new')),('_recover_prepared Windows prefix',fn('_recover_prepared').split('    s_st = _lstat_opt',1)[0]),('_commit_published',fn('_commit_published')),('propose tail; windows=request-selected IO; parsed/key/id/paths bound','    journal = _load_journal'+fn('propose').split('    journal = _load_journal',1)[1])]
prompt=header+'\n'.join('\n'+name+'\n```python\n'+code+'\n```\n' for name,code in parts)
assert len(prompt.encode())<10000,len(prompt.encode())
(out/'proposals-grok.prompt.md').write_text(prompt)
schema={'type':'object','properties':{'findings':{'type':'array','maxItems':4,'items':{'type':'object','properties':{'severity':{'type':'string','enum':['high','medium','low']},'function':{'type':'string'},'issue':{'type':'string'},'trigger':{'type':'string'},'correction':{'type':'string'}},'required':['severity','function','issue','trigger','correction'],'additionalProperties':False}},'reviewedScope':{'type':'string'},'limits':{'type':'array','items':{'type':'string'}}},'required':['findings','reviewedScope','limits'],'additionalProperties':False}
(out/'proposals-grok.schema.json').write_text(json.dumps(schema,indent=2)+'\n')
(out/'proposals-grok-input.json').write_text(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourcePath':str(path),'sourceSha256':hashlib.sha256(path.read_bytes()).hexdigest(),'promptBytes':len(prompt.encode()),'promptSha256':hashlib.sha256(prompt.encode()).hexdigest()},indent=2)+'\n')
base=Path('outputs/hermes-memory-windows-2026-09-22/review47-run.py').read_text().replace('review47-grok','proposals-grok').replace('review47-run.json','proposals-grok-run.json').replace('1800','600')
(out/'proposals-grok-run.py').write_text(base)
print(json.dumps({'promptBytes':len(prompt.encode()),'sourceSha256':hashlib.sha256(path.read_bytes()).hexdigest(),'timeoutSeconds':600}))
