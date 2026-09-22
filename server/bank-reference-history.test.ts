import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { WorkflowDatabase } from './workflow-database.ts';
import { BankReferenceStore, type SavedBankBatch } from './bank-reference-store.ts';
import { bankDigest, createBankReferenceBatch, reviewBankReferences, type BankReferenceUpload } from './bank-reference.ts';
import { bankReferenceQuery } from './bank-reference-query.ts';
import { validateSavedBankBatch } from './bank-reference-validation.ts';

const key=Buffer.alloc(32,19),fixtures:{dir:string;databases:WorkflowDatabase[]}[]=[],workers:Worker[]=[];
afterEach(async()=>{await Promise.all(workers.splice(0).map(worker=>worker.terminate()));vi.restoreAllMocks();for(const f of fixtures.splice(0)){for(const db of f.databases)db.close();rmSync(f.dir,{recursive:true,force:true});}});
function fixture(){const dir=mkdtempSync(join(tmpdir(),'realbud-bank-history-')),db=new WorkflowDatabase({dir,key});const resource={dir,databases:[db]};fixtures.push(resource);
  return {dir,db,store:new BankReferenceStore(db),open:()=>{const other=new WorkflowDatabase({dir,key});resource.databases.push(other);return new BankReferenceStore(other);}};}
const upload=(n=0):BankReferenceUpload=>({source:{filename:`fictional-${n}.csv`,bytesBase64:Buffer.from(`\uFEFFDate,Amount,Narrative,Reference,Extra\r\n2026-09-21,500.00,"Fictional café 🏡 ${n}","old",保留\r\n`).toString('base64')},
  columns:{date:'Date',amount:'Amount',narrative:'Narrative',reference:'Reference'},dateFormat:'YYYY-MM-DD',rules:[{propertyId:'fictional-property',reference:'00127',aliases:['Fictional']}]});
const decisions=(value:SavedBankBatch)=>value.batch.rows.map(row=>({rowId:row.id,action:'assign' as const,propertyId:'fictional-property',reason:'Reviewed fictional source and directory.'}));

async function race(dir:string,operations:{method:'create'|'review'|'amend';args:unknown[]}[]){
  const barrier=new SharedArrayBuffer(4),state=new Int32Array(barrier);
  return Promise.all(operations.map(operation=>new Promise<{status:number;id?:string;revision?:number}>((resolve,reject)=>{
    let result:{status:number;id?:string;revision?:number}|undefined;
    const worker=new Worker(`const {workerData,parentPort}=require('node:worker_threads');(async()=>{
      const {WorkflowDatabase}=await import(workerData.database),{BankReferenceStore}=await import(workerData.domain);
      const db=new WorkflowDatabase({dir:workerData.dir,key:Buffer.alloc(32,19)}),store=new BankReferenceStore(db),state=new Int32Array(workerData.barrier);
      Atomics.add(state,0,1);parentPort.postMessage('ready');while(Atomics.load(state,0)<=workerData.parties){const value=Atomics.load(state,0);if(value>workerData.parties)break;Atomics.wait(state,0,value);}
      try{const result=store[workerData.operation.method](...workerData.operation.args);parentPort.postMessage({status:200,id:result.id,revision:result.revision});}
      catch(error){parentPort.postMessage({status:error.status??500});}finally{db.close();}
    })();`,{eval:true,workerData:{dir,barrier,operation,parties:operations.length,database:new URL('./workflow-database.ts',import.meta.url).href,domain:new URL('./bank-reference-store.ts',import.meta.url).href},
      execArgv:['--experimental-strip-types'],env:{PATH:dirname(process.execPath),HOME:dir,USERPROFILE:dir,REALBUD_DATA_DIR:dir,REALBUD_DESK_KEY:key.toString('hex')}});
    workers.push(worker);worker.on('message',value=>{if(value==='ready'){if(Atomics.load(state,0)===operations.length){Atomics.add(state,0,1);Atomics.notify(state,0);}}else result=value;});
    worker.on('error',reject);worker.on('exit',code=>code||!result?reject(new Error(`Synthetic bank worker exited ${code}`)):resolve(result));
  })));
}

describe('permanent paged bank history',()=>{
  it('retains 501 encrypted batches with complete compatibility listing and exact old reviewed files after reopening',()=>{
    const f=fixture(),old=f.store.create(upload());const reviewed=f.store.review(old.id,old.revision,decisions(old.value));
    for(let i=1;i<501;i++)f.store.create(upload(i));
    vi.spyOn(f.db,'page').mockImplementation(()=>{throw new Error('History must not retain a full page of decrypted bank payloads.');});
    vi.spyOn(f.db,'list').mockImplementation(()=>{throw new Error('History must not use the truncated legacy database list.');});
    const first=f.store.page();expect(first).toMatchObject({version:2,total:501});expect(first.batches).toHaveLength(20);expect(first.batches.some(row=>row.id===old.id)).toBe(false);
    let cursor:string|undefined,ids:string[]=[];
    do{const page=f.store.page({cursor,limit:97});expect(page.total).toBe(501);expect(page.batches.length).toBeLessThanOrEqual(97);ids.push(...page.batches.map(row=>row.id));cursor=page.nextCursor??undefined;}while(cursor);
    expect(new Set(ids).size).toBe(501);expect(ids.at(-1)).toBe(old.id);expect(f.store.list()).toHaveLength(501);
    const reopened=f.open();expect(reopened.get(old.id)).toEqual(reviewed);expect(reopened.create(upload())).toEqual(reviewed);
    expect(reopened.export(old.id,true).bytesBase64).toBe(upload().source.bytesBase64);expect(reopened.export(old.id).bytesBase64).toBe(reviewed.value.result!.bytesBase64);
    expect(reopened.settings()).toEqual({columns:upload().columns,dateFormat:upload().dateFormat,rules:upload().rules});
    expect(readFileSync(join(f.dir,'workflow-state.sqlite')).includes(Buffer.from('Fictional café'))).toBe(false);
  });

  it('holds an exact insertion snapshot across new batches while existing reviews remain current',()=>{
    const f=fixture(),old=f.store.create(upload());for(let i=1;i<5;i++)f.store.create(upload(i));
    const first=f.store.page({limit:2}),newBatch=f.store.create(upload(99));f.store.review(old.id,old.revision,decisions(old.value));
    const ids=first.batches.map(row=>row.id);let cursor=first.nextCursor;
    while(cursor){const page=f.store.page({cursor,limit:1});expect(page.total).toBe(5);ids.push(...page.batches.map(row=>row.id));if(page.batches[0].id===old.id)expect(page.batches[0].revision).toBe(2);cursor=page.nextCursor;}
    expect(ids).toHaveLength(5);expect(new Set(ids).size).toBe(5);expect(ids).not.toContain(newBatch.id);expect(f.store.page().total).toBe(6);
  });

  it('deduplicates actual simultaneous handles and preserves the winning mapping against a competing create',async()=>{
    const f=fixture();
    const duplicate=await race(f.dir,[{method:'create',args:[upload()]},{method:'create',args:[upload()]}]);
    expect(duplicate.map(row=>row.status)).toEqual([200,200]);expect(duplicate[0].id).toBe(duplicate[1].id);expect(f.store.page().total).toBe(1);
    const a=upload(1),b=upload(1);b.rules[0].reference='00999';
    const competing=await race(f.dir,[{method:'create',args:[a]},{method:'create',args:[b]}]);
    expect(competing.map(row=>row.status).sort()).toEqual([200,409]);expect(f.store.page().total).toBe(2);
    const winner=f.store.get(competing.find(row=>row.status===200)!.id!);expect(['00127','00999']).toContain(winner.value.batch.input.rules[0].reference);
    expect(f.store.export(winner.id,true).bytesBase64).toBe(a.source.bytesBase64);
  },15_000);

  it('allows exactly one simultaneous revision-bound review',async()=>{
    const f=fixture(),row=f.store.create(upload());
    const outcomes=await race(f.dir,[{method:'review',args:[row.id,row.revision,decisions(row.value)]},{method:'review',args:[row.id,row.revision,decisions(row.value)]}]);
    expect(outcomes.map(outcome=>outcome.status).sort()).toEqual([200,409]);expect(f.store.get(row.id).revision).toBe(2);expect(f.store.export(row.id,true).bytesBase64).toBe(upload().source.bytesBase64);
  },15_000);

  it('atomically deduplicates simultaneous amendments and rejects a competing mapping without forking history',async()=>{
    const f=fixture(),row=f.store.create(upload()),saved=f.store.review(row.id,row.revision,decisions(row.value));
    const {source:_,...mapping}=upload();mapping.rules[0].reference='00234';
    const input={revision:saved.revision,mapping,reason:'Corrected fictional reference'};
    const replies=await race(f.dir,[{method:'amend',args:[saved.id,input]},{method:'amend',args:[saved.id,input]}]);
    expect(replies.map(row=>row.status)).toEqual([200,200]);expect(replies[0].id).toBe(`${saved.id}:r2`);expect(replies[0].id).toBe(replies[1].id);expect(f.db.count('bank')).toBe(2);
    const second=f.store.get(replies[0].id!);
    const different={...input,revision:second.revision,mapping:{...mapping,rules:[{...mapping.rules[0],reference:'00345'}]}};
    const outcomes=await race(f.dir,[{method:'amend',args:[second.id,{...input,revision:second.revision}]},{method:'amend',args:[second.id,different]}]);
    expect(outcomes.map(row=>row.status).sort()).toEqual([200,409]);expect(f.db.count('bank')).toBe(3);
  },15_000);

  it.each(['amount','candidates','source','prepared amount','prepared changes','missing timestamp'] as const)('holds corrupted %s before reads, duplicate creation or review and preserves its encrypted row',kind=>{
    const f=fixture(),first=f.store.create(upload());const saved=kind.startsWith('prepared')?f.store.review(first.id,first.revision,decisions(first.value)):first;
    const broken=f.db.update<SavedBankBatch>('bank',saved.id,saved.revision,value=>{
      if(kind==='amount')value.batch.rows[0].amount='999.00';
      else if(kind==='candidates')value.batch.rows[0].candidates=['another-property'];
      else if(kind==='source')value.batch.source!.bytesBase64=Buffer.from('broken source').toString('base64');
      else if(kind==='prepared amount'){const bytes=Buffer.from(value.result!.csv.replace('500.00','999.00'));value.result={...value.result!,csv:bytes.toString(),bytesBase64:bytes.toString('base64'),byteLength:bytes.length,outputDigest:bankDigest(bytes)};}
      else if(kind==='prepared changes')value.result!.changes[0].to='00999';
      else delete (value as Partial<SavedBankBatch>).createdAt;
      return value;
    });
    const before=readFileSync(join(f.dir,'workflow-state.sqlite'));
    for(const work of [()=>f.store.get(saved.id),()=>f.store.page(),()=>f.store.settings(),()=>f.store.export(saved.id,true),()=>f.store.create(upload()),()=>f.store.review(saved.id,broken.revision,decisions(saved.value))])expect(work).toThrow(expect.objectContaining({status:503}));
    expect(f.db.get('bank',saved.id)).toEqual(broken);expect(readFileSync(join(f.dir,'workflow-state.sqlite'))).toEqual(before);expect(f.db.count('bank')).toBe(1);
  });

  it('refuses identity mismatch and unauthorized reference edits even when their output digest is recomputed',()=>{
    const f=fixture(),row=f.store.create(upload()),saved=f.store.review(row.id,row.revision,decisions(row.value));
    expect(()=>validateSavedBankBatch(`bank:${'0'.repeat(64)}`,saved.value)).toThrow();
    const changed=structuredClone(saved.value),bytes=Buffer.from(changed.result!.csv.replace('00127','00999'));
    changed.result={...changed.result!,csv:bytes.toString(),bytesBase64:bytes.toString('base64'),byteLength:bytes.length,outputDigest:bankDigest(bytes),changes:[{...changed.result!.changes[0],to:'00999'}]};
    expect(()=>validateSavedBankBatch(row.id,changed)).toThrow(expect.objectContaining({status:503}));expect(f.store.get(row.id)).toEqual(saved);
  });

  it('retains the exact historical v1 quote-removing reference splice without permitting other cell rewrites',()=>{
    const f=fixture(),request=upload(),{source,...mapping}=request;
    const batch=createBankReferenceBatch({...mapping,csv:Buffer.from(source.bytesBase64,'base64').toString('utf8')});
    const modern=reviewBankReferences(batch,decisions({version:1,createdAt:1,batch}));
    const csv=modern.csv.replace('"00127"','00127');
    const legacy:SavedBankBatch={version:1,createdAt:1,batch,result:{csv,changes:modern.changes,originalDigest:modern.originalDigest,outputDigest:bankDigest(csv)}};
    const saved=f.db.create('bank',`bank:${batch.originalDigest}`,legacy,null);
    expect(f.store.get(saved.id).value).toEqual(legacy);expect(f.store.export(saved.id).csv).toBe(csv);expect(f.store.export(saved.id).originalBytesCaptured).toBe(false);
    const changed=structuredClone(legacy);changed.result!.csv=csv.replace('保留','"保留"');changed.result!.outputDigest=bankDigest(changed.result!.csv);
    expect(()=>validateSavedBankBatch(saved.id,changed)).toThrow(expect.objectContaining({status:503}));
  });

  it.each(['cursor=','cursor=bad','limit=0','limit=101','limit=01','limit=1.2','limit=2&limit=3','cursor=a&cursor=b','propertyId=other','session=secret'])('rejects invalid or unknown HTTP history query %s',query=>{
    const f=fixture();expect(()=>f.store.page(bankReferenceQuery(new URLSearchParams(query),true))).toThrow(expect.objectContaining({status:400}));expect(f.db.hasRecords()).toBe(false);
  });

  it('rejects forged cursor kinds, bounds and fields; non-history routes accept no list query',()=>{
    const f=fixture();f.store.create(upload());f.store.create(upload(1));const first=f.store.page({limit:1});
    const cursor=JSON.parse(Buffer.from(first.nextCursor!,'base64url').toString());
    for(const patch of [{kind:'execution-job'},{high:99999},{before:0},{before:cursor.high+1},{version:2},{extra:true}])expect(()=>f.store.page({cursor:Buffer.from(JSON.stringify({...cursor,...patch})).toString('base64url')})).toThrow(expect.objectContaining({status:400}));
    expect(()=>bankReferenceQuery(new URLSearchParams('limit=1'))).toThrow();expect(bankReferenceQuery(new URLSearchParams())).toEqual({});
  });
});
