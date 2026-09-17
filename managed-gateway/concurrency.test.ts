import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fixture,FIXTURE_TIME } from './testing.ts';
import { LedgerDatabase } from './database.ts';
import { UsageLedger } from './ledger.ts';

test('two independent processes cannot reserve more than one shared monthly cap',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'realbud-cap-processes-')),path=join(directory,'ledger.sqlite');
  const f=fixture(path);f.ledger.setCaps(f.owner,{monthlyCapNanoAud:'200000000',requestCapNanoAud:'200000000',maxConcurrent:4});
  const grant=f.grant(),bound=f.provider.bound(f.request);f.close();
  const children:ReturnType<typeof spawn>[]=[];
  try {
    const databaseUrl=new URL('./database.ts',import.meta.url).href,ledgerUrl=new URL('./ledger.ts',import.meta.url).href;
    const runs=[1,2].map(async n=>{
      const code=`import {LedgerDatabase} from ${JSON.stringify(databaseUrl)};import {UsageLedger} from ${JSON.stringify(ledgerUrl)};
        const db=new LedgerDatabase(process.argv[1]),ledger=new UsageLedger(db,()=>${FIXTURE_TIME});
        const grant=${JSON.stringify({...grant,jti:`grant-${n}`,attemptId:`attempt-${n}`})};
        process.stdout.write('ready\\n');for await(const chunk of process.stdin){try{ledger.reserve(grant,'fixture-host-key','fingerprint-${n}','idem-${n}',${JSON.stringify(bound)});process.stdout.write('reserved\\n');}catch(e){process.stdout.write(e.code+'\\n');}break;}db.close();`;
      const child=spawn(process.execPath,['--experimental-strip-types','--input-type=module','-e',code,path],{stdio:['pipe','pipe','pipe']});children.push(child);
      let stdout='',stderr='';child.stdout!.on('data',chunk=>{stdout+=chunk;});child.stderr!.on('data',chunk=>{stderr+=chunk;});
      const exited=once(child,'exit');await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('child readiness timeout')),5000);child.stdout!.once('data',()=>{clearTimeout(timer);resolve();});child.once('error',reject);});
      return {child,exited,output:()=>({stdout,stderr})};
    });
    const ready=await Promise.all(runs);for(const r of ready)r.child.stdin!.end('go\n');
    for(const r of ready) { const [code]=await r.exited;assert.equal(code,0,r.output().stderr); }
    const outcomes=ready.map(r=>r.output().stdout.trim().split('\n').at(-1)).sort();assert.deepEqual(outcomes,['monthly_cap_exceeded','reserved']);
    const db=new LedgerDatabase(path);try{const ledger=new UsageLedger(db,()=>FIXTURE_TIME);assert.equal(ledger.requests('company-a').length,1);assert.equal(ledger.exposure('company-a','2026-09'),165000000n);db.verify();}finally{db.close();}
  }finally{for(const child of children)if(child.exitCode===null)child.kill();rmSync(directory,{recursive:true,force:true});}
});

test('two independent processes share one immutable attempt cap across distinct children',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'realbud-cap-processes-')),path=join(directory,'ledger.sqlite');
  const f=fixture(path);f.ledger.setCaps(f.owner,{monthlyCapNanoAud:'100000000000',requestCapNanoAud:'200000000',maxConcurrent:4});
  const grant=f.grant(f.request,{schema:2,grantVersion:2,modelCallId:'child',provider:'synthetic-provider',maxAttemptSpendNanoAud:'200000000',attemptExpiresAt:FIXTURE_TIME+120000,allowedModels:[{provider:'synthetic-provider',model:f.request.model,capabilities:['text']}]}),bound=f.provider.bound(f.request);f.close();
  const children:ReturnType<typeof spawn>[]=[];
  try {
    const databaseUrl=new URL('./database.ts',import.meta.url).href,ledgerUrl=new URL('./ledger.ts',import.meta.url).href;
    const runs=[1,2].map(async n=>{
      const code=`import {LedgerDatabase} from ${JSON.stringify(databaseUrl)};import {UsageLedger} from ${JSON.stringify(ledgerUrl)};
        const db=new LedgerDatabase(process.argv[1]),ledger=new UsageLedger(db,()=>${FIXTURE_TIME});
        const grant=${JSON.stringify({...grant,jti:`grant-${n}`,modelCallId:`child-${n}`})};
        process.stdout.write('ready\\n');for await(const chunk of process.stdin){try{ledger.reserve(grant,'fixture-host-key','fingerprint-${n}','idem-${n}',${JSON.stringify(bound)});process.stdout.write('reserved\\n');}catch(e){process.stdout.write(e.code+'\\n');}break;}db.close();`;
      const child=spawn(process.execPath,['--experimental-strip-types','--input-type=module','-e',code,path],{stdio:['pipe','pipe','pipe']});children.push(child);
      let stdout='',stderr='';child.stdout!.on('data',chunk=>{stdout+=chunk;});child.stderr!.on('data',chunk=>{stderr+=chunk;});
      const exited=once(child,'exit');await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('child readiness timeout')),5000);child.stdout!.once('data',()=>{clearTimeout(timer);resolve();});child.once('error',reject);});
      return {child,exited,output:()=>({stdout,stderr})};
    });
    const ready=await Promise.all(runs);for(const r of ready)r.child.stdin!.end('go\n');
    for(const r of ready) { const [code]=await r.exited;assert.equal(code,0,r.output().stderr); }
    const outcomes=ready.map(r=>r.output().stdout.trim().split('\n').at(-1)).sort();assert.deepEqual(outcomes,['attempt_cap_exceeded','reserved']);
    const db=new LedgerDatabase(path);try{const ledger=new UsageLedger(db,()=>FIXTURE_TIME);assert.equal(ledger.requests('company-a').length,1);assert.equal(ledger.exposure('company-a','2026-09'),165000000n);db.verify();}finally{db.close();}
  }finally{for(const child of children)if(child.exitCode===null)child.kill();rmSync(directory,{recursive:true,force:true});}
});
