"""Isolated transition probes; no Win32/profile/filesystem operations under test."""
from pathlib import Path
import hashlib,importlib.util,json,types
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
SOURCE=ROOT/'server/helpers/hermes-memory-proposals.py'
spec=importlib.util.spec_from_file_location('proposal_transition_probe',SOURCE)
mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
class Error(Exception):
 def __init__(self,code):self.code=code;super().__init__(code)
BLOB=b'fictional pending payload';DIGEST=hashlib.sha256(BLOB).hexdigest();KEY='a'*64;ID=KEY[:8]
class IO:
 def __init__(self):self.files={};self.events=[];self.crash_after_move=False;self.collision_on_write=False
 def read(self,path,limit=131072,missing_ok=False):
  data=self.files.get(path)
  if data is None and not missing_ok:raise Error('unavailable')
  if data is not None and len(data)>limit:raise Error('capacity')
  return data
 def names(self,path,limit,missing_ok=True):
  result=[p for p in self.files if str(Path(p).parent)==path]
  if len(result)>limit:raise Error('capacity')
  return result
 def write_new(self,path,data):
  self.events.append('write-new')
  if self.collision_on_write:self.files[path]=b'foreign'
  if path in self.files:raise Error('conflict')
  self.files[path]=data
 def move_new(self,source,target,digest):
  self.events.append('move-new')
  if target in self.files:raise Error('conflict')
  if hashlib.sha256(self.files[source]).hexdigest()!=digest:raise Error('conflict')
  self.files[target]=self.files.pop(source)
  if self.crash_after_move:
   self.crash_after_move=False
   raise Error('recovery-required')
def fixture():
 io=IO();ctx=types.SimpleNamespace(profile_dir='/fictional',reviews_dir='/fictional/reviews')
 review=types.SimpleNamespace(ReviewError=Error,MAX_BYTES=131072,MAX_DIR=100,
  _windows_io=lambda profile:io,_path_exists=lambda profile,path:path in io.files,
  _sha=lambda data:hashlib.sha256(data).hexdigest(),
  _safe_read=lambda profile,path,**kw:io.read(path,**kw),
  _pending_path=lambda ctx,id:'/fictional/pending/'+id+'.json')
 parsed={'scope_id':'b'*64,'request_digest':'c'*64,'payload':{'fictional':True}}
 journal={'pendingDigest':DIGEST,'id':ID,'scopeId':parsed['scope_id'],'requestKey':KEY,'requestDigest':parsed['request_digest']}
 stage=mod._stage_path(ctx,KEY);pending=review._pending_path(ctx,ID)
 def commit(_review,_ctx,_parsed,_key,_id,digest):
  assert stage not in io.files and hashlib.sha256(io.files[pending]).hexdigest()==digest
  io.events.append('commit');return mod._ok(_id)
 return io,ctx,review,parsed,journal,stage,pending,commit
checks=[]
def run(name,setup,expected=None,events=None):
 io,ctx,review,parsed,journal,stage,pending,commit=fixture();setup(io,stage,pending)
 with patch.object(mod,'_dry_run',side_effect=lambda *_:io.events.append('dry-run')),patch.object(mod,'_ensure_native_room',side_effect=lambda *_,**kw:io.events.append('capacity')),patch.object(mod,'_commit_published',side_effect=commit):
  try:result=mod._recover_prepared(review,ctx,journal,parsed,KEY,ID,BLOB)
  except Error as error:
   assert error.code==expected,(name,error.code,expected)
  else:
   assert expected is None and result==mod._ok(ID)
 if events is not None:assert io.events==events,(name,io.events)
 checks.append({'name':name,'passed':True});return io,stage,pending
with patch.object(mod.os,'lstat',side_effect=AssertionError('forbidden POSIX lstat')),patch.object(mod.os.path,'lexists',side_effect=AssertionError('forbidden POSIX lexists')),patch.object(mod.os,'link',side_effect=AssertionError('forbidden POSIX link')),patch.object(mod.os,'unlink',side_effect=AssertionError('forbidden POSIX unlink')):
 run('stage-only publishes once',lambda io,s,p:io.files.update({s:BLOB}),events=['dry-run','capacity','move-new','commit'])
 run('pending-only reconciles without restaging',lambda io,s,p:io.files.update({p:BLOB}),events=['commit'])
 io,s,p=run('both names held',lambda io,s,p:io.files.update({s:BLOB,p:BLOB}),'conflict',[]);assert io.files=={s:BLOB,p:BLOB}
 run('both missing never reconstructed',lambda *_:None,'recovery-required',[])
 io,s,p=run('mismatched stage preserved',lambda io,s,p:io.files.update({s:b'foreign'}),'recovery-required',[]);assert io.files[s]==b'foreign'
 io,s,p=run('mismatched pending preserved',lambda io,s,p:io.files.update({p:b'foreign'}),'recovery-required',[]);assert io.files[p]==b'foreign'
 io,ctx,review,parsed,journal,stage,pending,commit=fixture();io.files[stage]=BLOB;io.crash_after_move=True
 with patch.object(mod,'_dry_run',return_value=None),patch.object(mod,'_ensure_native_room',return_value=None),patch.object(mod,'_commit_published',side_effect=commit):
  try:mod._recover_prepared(review,ctx,journal,parsed,KEY,ID,BLOB)
  except Error as error:assert error.code=='recovery-required'
  else:raise AssertionError('lost-response fault did not fire')
  assert stage not in io.files and io.files[pending]==BLOB
  assert mod._recover_prepared(review,ctx,journal,parsed,KEY,ID,BLOB)==mod._ok(ID)
  assert io.events==['move-new','commit']
 checks.append({'name':'lost move response reconciles without second move','passed':True})
 io,ctx,review,parsed,journal,stage,pending,commit=fixture();io.files[stage]=BLOB
 with patch.object(mod,'_dry_run',side_effect=Error('disabled')):
  try:mod._recover_prepared(review,ctx,journal,parsed,KEY,ID,BLOB)
  except Error as error:assert error.code=='disabled'
  else:raise AssertionError('disabled readiness was ignored')
 assert io.files=={stage:BLOB} and io.events==[];checks.append({'name':'disabled recovery cannot publish stage','passed':True})
 io,ctx,review,parsed,journal,stage,pending,commit=fixture();io.files[stage]=BLOB
 try:mod._write_stage(review,ctx,stage,BLOB,DIGEST)
 except Error as error:assert error.code=='conflict'
 else:raise AssertionError('new publication adopted an existing matching stage')
 assert io.files=={stage:BLOB};checks.append({'name':'new publication rejects an existing matching stage','passed':True})
 io,ctx,review,parsed,journal,stage,pending,commit=fixture();io.collision_on_write=True
 try:mod._write_stage(review,ctx,stage,BLOB,DIGEST)
 except Error as error:assert error.code=='conflict'
 else:raise AssertionError('exclusive stage collision overwritten')
 assert io.files[stage]==b'foreign';checks.append({'name':'stage creation collision is preserved','passed':True})
receipt={'passed':len(checks),'failed':0,'checks':checks,'sourceSha256':hashlib.sha256(SOURCE.read_bytes()).hexdigest(),'scope':'actual proposal transition functions with synthetic dictionary IO and isolated commit/readiness callbacks','WindowsNativeExecuted':False,'realProfilesAccessed':False}
(ROOT/'outputs/hermes-memory-windows-journal-2026-09-22/proposals-state-checks.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt))
