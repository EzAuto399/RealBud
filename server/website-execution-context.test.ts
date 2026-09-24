import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createWebsiteExecutionContext } from './website-execution-context.ts';
import type { WebsiteRequestExecution } from './website-requests.ts';
function fixture(){
 const requestId=randomUUID();
 const execution:WebsiteRequestExecution={requestId,descriptor:{id:randomUUID(),operation:'prepare-recipe',revision:'a'.repeat(64),label:'Fictional preparation'},binding:{recipeId:'fictional',recipeRevision:1}};
 return {requestId,execution};
}
it('refuses a website dispatch when its durable request is missing',async()=>{
 const {requestId}=fixture();let checked=0;
 const context=createWebsiteExecutionContext({binding:()=>null,check:async()=>{checked++;}});
 await expect(context.run(requestId,()=>context.check())).rejects.toThrow(/permission changed/);expect(checked).toBe(0);
});
it('rechecks permission after an awaited source check before allowing provider entry',async()=>{
 const {requestId,execution}=fixture();let allowed=true,release!:()=>void,entered!:()=>void,providerCalls=0;
 const pending=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
 const context=createWebsiteExecutionContext({binding:()=>allowed?execution:null,check:async()=>{entered();await pending;}});
 const work=context.run(requestId,async()=>{await context.check();providerCalls++;});
 await started;allowed=false;release();await expect(work).rejects.toThrow(/permission changed/);expect(providerCalls).toBe(0);
});
it('retains required provenance in the queued Morning callback without affecting manual work',async()=>{
 const {requestId}=fixture();const context=createWebsiteExecutionContext({binding:()=>null,check:async()=>{}});
 const work=context.run(requestId,()=>new Promise<void>((resolve,reject)=>queueMicrotask(()=>{void context.runLoop(requestId,()=>context.check()).then(resolve,reject);}))); 
 await expect(work).rejects.toThrow(/permission changed/);
 await expect(context.runLoop(randomUUID(),()=>context.check())).resolves.toBeUndefined();
 await expect(context.runLoop(undefined,()=>context.check())).resolves.toBeUndefined();
});
it('requires current permission for a recovered loop associated with a saved website request',async()=>{
 const {requestId}=fixture();const context=createWebsiteExecutionContext({binding:id=>{if(id===requestId)throw Error('Recovered request has no live permission');return null;},check:async()=>{}});
 await expect(context.runLoop(requestId,()=>context.check())).rejects.toThrow(/no live permission/);
});
