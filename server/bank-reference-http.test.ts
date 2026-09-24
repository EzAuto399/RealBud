// The real desktop HTTP/session boundary, with an isolated synthetic database.
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WorkflowDatabase } from './workflow-database.ts';
import { BankReferenceStore } from './bank-reference-store.ts';
import type { BankReferenceUpload } from './bank-reference.ts';
import type { BankHistoryPage } from '../shared/bank-reference-history.ts';

const ROOT=join(dirname(fileURLToPath(import.meta.url)),'..'),directory=mkdtempSync(join(tmpdir(),'realbud-bank-http-')),data=join(directory,'data'),key=Buffer.alloc(32,23);
let child:ChildProcess,closed:Promise<unknown>,base='',session='',oldId='',oldPrepared='',logs='';
const read = <T>(response:Response) => response.json() as Promise<T>;
const upload=(n:number):BankReferenceUpload=>({source:{filename:`fictional-${n}.csv`,bytesBase64:Buffer.from(`\uFEFFDate,Amount,Narrative,Reference\r\n2026-09-21,50.00,"Fictional café 🏡 ${n}","old"\r\n`).toString('base64')},columns:{date:'Date',amount:'Amount',narrative:'Narrative',reference:'Reference'},dateFormat:'YYYY-MM-DD',rules:[{propertyId:'fixture-property',reference:'00123',aliases:['Fictional']}]});
beforeAll(async()=>{
  mkdirSync(data,{mode:0o700});writeFileSync(join(data,'config.json'),JSON.stringify({instances:{fixture:{driver:'not-a-real-driver'}}}),{mode:0o600});
  const database=new WorkflowDatabase({dir:data,key});
  try{const bank=new BankReferenceStore(database),old=bank.create(upload(0));oldId=old.id;oldPrepared=bank.review(old.id,old.revision,old.value.batch.rows.map(row=>({rowId:row.id,action:'assign',propertyId:'fixture-property',reason:'Reviewed synthetic source.'}))).value.result!.bytesBase64!;
    // Commit synthetic retained history together before the real HTTP service opens it.
    database.transaction(()=>{for(let n=1;n<501;n++)bank.create(upload(n));});
  }finally{database.close();}
  const listener=createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=(listener.address() as {port:number}).port;await new Promise<void>(resolve=>listener.close(()=>resolve()));base=`http://127.0.0.1:${port}`;
  const {serviceSmokeEnv}=await import(new URL('../scripts/service-smoke-env.mjs',import.meta.url).href);
  child=spawn(process.execPath,[join(ROOT,'server/bootstrap.ts')],{cwd:ROOT,env:{...serviceSmokeEnv({executable:process.execPath,home:directory,data,scratch:directory,port}),REALBUD_DESK_KEY:key.toString('hex'),VITEST:'true'},stdio:['ignore','pipe','pipe']});
  closed=new Promise((resolve,reject)=>{child.once('close',resolve);child.once('error',reject);});
  for(const stream of [child.stdout,child.stderr])stream?.on('data',bytes=>{logs=(logs+bytes).slice(-10000);});
  let ready=false;
  for(let i=0;i<150;i++){
    if(child.exitCode!==null||child.signalCode!==null)throw new Error(`Synthetic bank service stopped before readiness: ${logs}`);
    const health=await fetch(base+'/api/health',{signal:AbortSignal.timeout(500)}).then(response=>read<{pid:number}>(response)).catch(()=>null);
    if(health?.pid===child.pid){ready=true;break;}await new Promise(resolve=>setTimeout(resolve,100));
  }
  if(!ready)throw new Error(`Synthetic bank service did not start: ${logs}`);
  session=(await read<{token:string}>(await fetch(base+'/api/session'))).token;
},30_000);
afterAll(async()=>{
  if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),5000);try{await closed;}finally{clearTimeout(timer);}}
  rmSync(directory,{recursive:true,force:true});
});
const request=(path:string,method='GET',body?:unknown,headers:Record<string,string>={})=>fetch(base+path,{method,signal:AbortSignal.timeout(10000),headers:{'x-realbud-session':session,'content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});

describe('bank history through the actual protected HTTP boundary',()=>{
  it('requires the session and trusted origin before history, settings and exact source are exposed',async()=>{
    for(const path of ['/api/bank-reference?limit=1','/api/bank-reference/settings',`/api/bank-reference/${oldId}`]){
      expect((await fetch(base+path)).status).toBe(401);expect((await request(path,'GET',undefined,{'x-realbud-session':'stale'})).status).toBe(401);
      expect((await request(path,'GET',undefined,{origin:'https://untrusted.example'})).status).toBe(403);
    }
    expect((await fetch(base+`/api/bank-reference/${oldId}/original`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status).toBe(401);
  });

  it('pages beyond 500 with exact snapshot totals, then opens and exports a reviewed record outside the loaded page',async()=>{
    const response=await request('/api/bank-reference?limit=20');expect(response.status).toBe(200);const first=await response.json() as BankHistoryPage;
    expect(first).toMatchObject({version:2,total:501});expect(first.batches).toHaveLength(20);expect(first.batches.some(row=>row.id===oldId)).toBe(false);
    const inserted=await request('/api/bank-reference','POST',upload(999));expect(inserted.status).toBe(200);const added=await read<{id:string}>(inserted);
    let cursor=first.nextCursor,ids=first.batches.map(row=>row.id);
    while(cursor){const pageResponse=await request(`/api/bank-reference?limit=100&cursor=${cursor}`);expect(pageResponse.status).toBe(200);const page=await pageResponse.json() as BankHistoryPage;expect(page.total).toBe(501);ids.push(...page.batches.map(row=>row.id));cursor=page.nextCursor;}
    expect(new Set(ids).size).toBe(501);expect(ids.at(-1)).toBe(oldId);expect(ids).not.toContain(added.id);
    expect((await read<{revision:number}>(await request(`/api/bank-reference/${oldId}`))).revision).toBe(2);
    const original=await read<{bytesBase64:string}>(await request(`/api/bank-reference/${oldId}/original`,'POST',{}));expect(original.bytesBase64).toBe(upload(0).source.bytesBase64);
    const prepared=await read<{bytesBase64:string}>(await request(`/api/bank-reference/${oldId}/export`,'POST',{}));expect(prepared.bytesBase64).toBe(oldPrepared);
    expect((await read<BankHistoryPage>(await request('/api/bank-reference'))).total).toBe(502);
    expect((await read<{id:string}>(await request('/api/bank-reference','POST',upload(0)))).id).toBe(oldId);
  });

  it('rejects malformed/duplicated list options and misplaced queries without changing history',async()=>{
    const before=(await read<BankHistoryPage>(await request('/api/bank-reference'))).total;
    for(const path of ['/api/bank-reference?limit=101','/api/bank-reference?limit=2&limit=3','/api/bank-reference?cursor=bad','/api/bank-reference?accountId=other','/api/bank-reference/settings?limit=1',`/api/bank-reference/${oldId}?cursor=bad`])expect((await request(path)).status).toBe(400);
    expect((await request('/api/bank-reference?limit=1','POST',upload(700))).status).toBe(400);
    expect((await read<BankHistoryPage>(await request('/api/bank-reference'))).total).toBe(before);
  });
});
