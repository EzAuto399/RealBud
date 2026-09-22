// Actual local HTTP/bootstrap boundaries; disposable fictional data only.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serviceSmokeEnv } from './service-smoke-env.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
// Explicit installed mode cannot fall back to the checkout or a local Node.
const packaged=process.env.REALBUD_QA_RESOURCES!==undefined||process.env.REALBUD_QA_EXECUTABLE!==undefined;
let resources=null,executable=process.execPath;
if(packaged){
 assert.ok(process.env.REALBUD_QA_RESOURCES?.trim()&&process.env.REALBUD_QA_EXECUTABLE?.trim(),'Packaged QA requires both REALBUD_QA_RESOURCES and REALBUD_QA_EXECUTABLE.');
 resources=realpathSync(resolve(process.env.REALBUD_QA_RESOURCES));executable=realpathSync(resolve(process.env.REALBUD_QA_EXECUTABLE));
 assert.ok(statSync(resources).isDirectory(),'Installed resources must be a directory.');
 for(const path of [executable,join(resources,'server/bootstrap.js'),join(resources,'ui/index.html')])assert.ok(statSync(path).isFile(),`Required installed file is missing or invalid: ${path}`);
}
const bootstrap=packaged?join(resources,'server/bootstrap.js'):join(root,'server/bootstrap.ts'),serviceCwd=packaged?resources:root;
// Windows admits only objects carrying their own protected descriptor, which the
// product gives everything it creates. Folders and notes this script plants get
// the same from the product's own helper, as POSIX gets mode 0700/0600 below.
const protect=process.platform==='win32'?(await import(pathToFileURL(packaged?join(resources,'server/windows-file-privacy.js'):join(root,'server/windows-file-privacy.ts')).href)).windowsFilePrivacySync:()=>{};
// Only folders this call creates, and only strictly inside the disposable data
// directory: never an ancestor the script does not own.
const plantPrivate=(path,content)=>{const missing=[];
 for(let at=dirname(path);!existsSync(at);at=dirname(at)){const inside=relative(data,at);assert.ok(inside&&!inside.startsWith('..')&&!isAbsolute(inside),'Planted folder is outside the disposable data directory.');missing.unshift(at);}
 for(const dir of missing){mkdirSync(dir,{mode:0o700});protect(dir,'directory',true);}
 writeFileSync(path,'',{mode:0o600,flag:'wx'});protect(path,'file',true);writeFileSync(path,content);};
let runtime={node:process.versions.node,electron:process.versions.electron??null};
const scratch=mkdtempSync(join(realpathSync(tmpdir()),'RealBud backup boundaries ')), data=join(scratch,'data');
const output=resolve(process.env.QA_OUTPUT || join(root,packaged?'outputs/private-backup-packaged-2026-09-21/boundaries.json':'outputs/private-backup-2026-09-21/boundaries.json'));
// The script creates the data folder and its fixture config, so it protects both
// on Windows, as the desktop app's key custody does for the folder it creates.
mkdirSync(data,{mode:0o700});protect(data,'directory',true);
plantPrivate(join(data,'config.json'),JSON.stringify({instances:{fixture:{driver:'not-a-real-driver'}}}));
const pause=ms=>new Promise(r=>setTimeout(r,ms)),checks=[],skipped=[];
let child,token,base,port,failure,logs='',incomplete;
const check=message=>{checks.push(message);console.log(`PASS ${message}`);};
async function stop(){if(child?.exitCode===null&&!child.signalCode){child.kill('SIGTERM');await Promise.race([once(child,'exit'),pause(5000)]);if(child.exitCode===null&&!child.signalCode){child.kill('SIGKILL');await once(child,'exit');}}}
async function start(){child=spawn(executable,[bootstrap],{cwd:serviceCwd,env:{...serviceSmokeEnv({executable,home:scratch,data,scratch,port}),REALBUD_MANAGED_SERVICE:'0',REALBUD_TEST_LAB:'1'},windowsHide:true,stdio:['ignore','pipe','pipe']});
 let spawnError;child.once('error',error=>{spawnError=error;});
 for(const stream of [child.stdout,child.stderr])stream.on('data',b=>logs=(logs+b).slice(-10000));
 // Windows admits every file the service creates through PowerShell before content,
 // so a fresh boot takes several seconds longer there than on macOS or Linux.
 const startedAt=Date.now(),budget=process.platform==='win32'?90_000:15_000;
 while(Date.now()-startedAt<budget){if(spawnError)throw spawnError;if(child.exitCode!==null||child.signalCode)break;try{const health=await(await fetch(base+'/api/health',{signal:AbortSignal.timeout(500)})).json();if(health.app==='realbud'&&health.pid===child.pid){token=(await(await fetch(base+'/api/session')).json()).token;return;}}catch{}await pause(100);}
 throw new Error(`Service failed to start after ${Date.now()-startedAt} ms (exit ${child.exitCode??'none'}${child.signalCode?`, signal ${child.signalCode}`:''})${logs?`: ${logs.slice(-3000)}`:''}`);}
async function call(path,method='GET',body,status=200){const response=await fetch(base+path,{method,signal:AbortSignal.timeout(30000),headers:{'content-type':'application/json','x-realbud-session':token},...(body===undefined?{}:{body:JSON.stringify(body)})});const result=await response.json();assert.equal(response.status,status,`${path}: ${JSON.stringify(result)}`);return result;}
try{
 if(packaged){
  const probe=spawnSync(executable,['-e','console.log(JSON.stringify({node:process.versions.node,electron:process.versions.electron??null}))'],{cwd:resources,env:serviceSmokeEnv({executable,home:scratch,data,scratch,port:0}),encoding:'utf8',timeout:10000,maxBuffer:16384,windowsHide:true});
  assert.equal(probe.error,undefined,'Installed runtime could not start.');assert.equal(probe.status,0,`Installed runtime probe failed: ${probe.stderr}`);runtime=JSON.parse(probe.stdout.trim());
  assert.ok(typeof runtime.electron==='string'&&typeof runtime.node==='string','Installed QA requires the application Electron executable in Node mode.');
 }
 const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');port=socket.address().port;await new Promise(r=>socket.close(r));base=`http://127.0.0.1:${port}`;await start();
 assert.equal((await call('/api/private-backup')).canRestore,true);
 for(const [path,body] of [['/api/private-backup/export',{passphrase:'Fictional backup phrase 2026'}],['/api/private-backup/restore',{confirm:true}]]){
  assert.equal((await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).status,401);
  assert.equal((await fetch(base+path,{method:'POST',headers:{'content-type':'application/json','x-realbud-session':token,origin:'https://foreign.example'},body:JSON.stringify(body)})).status,403);
 }check('Actual sensitive backup routes reject missing session and foreign origin');
 const phrase='Fictional private backup testing 2026';
 const exported=await call('/api/private-backup/export','POST',{passphrase:phrase});
 const receipt=await call('/api/private-backup/preview','POST',{backup:exported.backup,passphrase:phrase});
 const restore={backup:exported.backup,passphrase:phrase,expectedDigest:receipt.digest,confirm:true};
 for(const name of ['properties/fixture.md','owners/fixture.md','decisions/fixture.md','workflow-support/fixture/SKILL.md','workflow-inputs/fixture.json']){
  const path=join(data,'vault',name);plantPrivate(path,'Fictional private note');
  assert.equal((await call('/api/private-backup')).canRestore,false,name);await call('/api/private-backup/restore','POST',restore,409);assert.equal(readFileSync(path,'utf8'),'Fictional private note');rmSync(path);
  if(name.startsWith('workflow-support/'))rmSync(dirname(path),{recursive:true});
 }
 const userPath=join(data,'vault/USER.md'),original=readFileSync(userPath);writeFileSync(userPath,'Fictional custom business instructions');assert.equal((await call('/api/private-backup')).canRestore,false);await call('/api/private-backup/restore','POST',restore,409);assert.equal(readFileSync(userPath,'utf8'),'Fictional custom business instructions');writeFileSync(userPath,original);
 check('Private notes, workflow inputs, instruction packs and edited personal instructions block replacement and remain intact');
 const company=join(data,'company-installation/seat.json');writeFileSync(company,JSON.stringify({fixture:true}),{mode:0o600});assert.equal((await call('/api/private-backup')).canRestore,false);await call('/api/private-backup/restore','POST',restore,409);rmSync(company);
 check('Existing company enrollment files block restoration');
 await call('/api/private-backup/restore','POST',{...restore,expectedDigest:'0'.repeat(64)},409);assert.equal((await call('/api/private-backup')).staged,false);assert.equal((await call('/api/private-backup')).canRestore,true);
 incomplete=httpRequest(base+'/api/workspace-tabs',{method:'PUT',headers:{'content-type':'application/json','x-realbud-session':token}});incomplete.on('error',()=>{});incomplete.write('{');await pause(100);
 await call('/api/private-backup/restore','POST',restore,409);incomplete.destroy();incomplete=null;await pause(100);
 check('Stale preview and concurrent unfinished business requests refuse staging without stranding the workspace');
 await call('/api/private-backup/restore','POST',restore);assert.equal((await call('/api/private-backup')).staged,true);
 for(const [path,method,body] of [['/api/desk','GET'],['/api/workspace-tabs','PUT',{}],['/api/private-backup/export','POST',{passphrase:phrase}],['/api/private-backup/restore','POST',restore]])await call(path,method,body,409);
 check('A staged restore holds business reads, writes, exports and duplicate restore attempts');
 const keyPath=join(data,'desk.key'),key=readFileSync(keyPath);await stop();
 if(process.platform!=='win32'){
  const stagePath=['private-workspace-restore-v2.json','private-workspace-restore.json'].map(name=>join(data,name)).find(path=>existsSync(path)),stageBytes=readFileSync(stagePath);
  chmodSync(keyPath,0o644);
  try{
   await assert.rejects(start(),/staged restore key needs recovery/);
   assert.notEqual(child.exitCode,0,'An insecure key must prevent bootstrap from starting.');
   assert.deepEqual(readFileSync(keyPath),key);assert.deepEqual(readFileSync(stagePath),stageBytes);
   assert.equal(existsSync(join(data,'private-workspace-restore-receipt.json')),false);
  }finally{await stop();chmodSync(keyPath,0o600);}
  check('POSIX bootstrap refuses a public destination key without consuming the staged restore; private permissions permit recovery');
 }else skipped.push('POSIX chmod refusal is not a Windows ACL test; native Windows bootstrap still enforces its ACL helper.');
 await start();assert.deepEqual(readFileSync(keyPath),key);assert.equal((await call('/api/private-backup')).staged,false);assert.equal((await call('/api/loops')).loops.some(l=>l.enabled),false);assert.ok(readdirSync(data).includes('private-workspace-restore-receipt.json'));
 const completed=JSON.parse(readFileSync(join(data,'private-workspace-restore-receipt.json'),'utf8'));assert.equal(completed.version,1);assert.equal(completed.receipt.digest,receipt.digest);assert.equal(completed.rekeyed,true);assert.equal(completed.reviewRequired,true);assert.ok(Number.isFinite(Date.parse(completed.restoredAt)));
 check('Cold bootstrap completes once with unchanged destination key, matching durable completion receipt and disabled schedules');
}catch(error){failure=error.stack||String(error);console.error(failure);process.exitCode=1;
 // Windows only: the product never names the refused path, so list which entries of this
 // disposable data folder fail the same admission. Relative paths of fictional fixtures only.
 if(process.platform==='win32'&&/windows-acl/.test(failure)){const refused=[];const walk=(dir)=>{for(const entry of readdirSync(dir,{withFileTypes:true})){const full=join(dir,entry.name),kind=entry.isDirectory()?'directory':'file';try{protect(full,kind,false);}catch(refusal){refused.push(`${relative(scratch,full)} ${kind} ${refusal?.category??'unknown'}`);}if(entry.isDirectory()&&!entry.isSymbolicLink())walk(full);}};
  for(const [label,path] of [['scratch',scratch],['data',data]]){try{protect(path,'directory',false);}catch(refusal){refused.push(`${label} itself directory ${refusal?.category??'unknown'}`);}}
  try{walk(scratch);}catch(walkError){refused.push(`walk stopped: ${walkError?.code??walkError?.name??'unknown'}`);}
  const listing=`unprotected entries (${refused.length}): ${refused.slice(0,40).join(' | ')}`;logs=`${logs}\n${listing}`;console.error(listing);}}
finally{incomplete?.destroy();await stop();rmSync(scratch,{recursive:true,force:true});mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify({at:new Date().toISOString(),passed:!failure,mode:packaged?'packaged':'source',platform:process.platform,arch:process.arch,executable,resources,bootstrap,runtime,layer:`${packaged?'Actual packaged Electron/Node and compiled bootstrap':'Actual source Node/bootstrap'} HTTP and isolated filesystem; fictional fixtures; not physical customer device, GUI, managed-service or live integration proof`,checks,skipped,failure,...(failure?{diagnostic:logs}:{})},null,2));}
