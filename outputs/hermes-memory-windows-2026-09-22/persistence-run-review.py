from pathlib import Path
import subprocess,json,time,os,signal,hashlib,datetime
out=Path(__file__).resolve().parent
args=['/Users/yoda/.local/bin/grok','--model','grok-4.6','--reasoning-effort','xhigh','--no-subagents','--tools','','--disable-web-search','--permission-mode','plan','--max-turns','1','--system-prompt-override','You are a bounded read-only Windows persistence design reviewer. Use only the supplied packet, no tools or external context. Return the requested structured result without reasoning traces. State uncertainty and distinguish documented behavior from untested inference.','--json-schema',(out/'persistence-grok-review.schema.json').read_text(),'--prompt-file',str(out/'persistence-grok-review.prompt.md')]
started=time.monotonic(); at=datetime.datetime.now(datetime.timezone.utc).isoformat()
receipt={'startedAt':at,'requestedModel':'grok-4.6','reasoningEffort':'xhigh','maxTurns':1,'tools':[],'webEnabled':False,'subagentsEnabled':False,'permissionMode':'plan','hardTimeoutSeconds':1800,'promptBytes':(out/'persistence-grok-review.prompt.md').stat().st_size,'promptSha256':hashlib.sha256((out/'persistence-grok-review.prompt.md').read_bytes()).hexdigest()}
(out/'persistence-grok-run.json').write_text(json.dumps(receipt,indent=2)+'\n')
with (out/'persistence-grok-review.raw.json').open('w') as stdout,(out/'persistence-grok-review.stderr').open('w') as stderr:
 proc=subprocess.Popen(args,stdout=stdout,stderr=stderr,start_new_session=True,cwd='/Users/yoda/projects/RealBud')
 try: receipt['exitCode']=proc.wait(timeout=1800)
 except subprocess.TimeoutExpired:
  receipt['timedOut']=True
  os.killpg(proc.pid,signal.SIGTERM)
  try: proc.wait(timeout=5)
  except subprocess.TimeoutExpired: os.killpg(proc.pid,signal.SIGKILL);proc.wait()
  receipt['exitCode']=proc.returncode
receipt['elapsedSeconds']=round(time.monotonic()-started,2)
try:
 raw=json.loads((out/'persistence-grok-review.raw.json').read_text())
 result={k:raw.get(k) for k in ['sessionId','requestId','stopReason','num_turns','usage','modelUsage','structuredOutput']}
 (out/'persistence-grok-review.json').write_text(json.dumps(result,indent=2)+'\n')
 receipt['sessionId']=raw.get('sessionId');receipt['hasStructuredOutput']=raw.get('structuredOutput') is not None
except (ValueError,OSError): receipt['hasStructuredOutput']=False
(out/'persistence-grok-run.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(receipt))
