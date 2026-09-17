/** Offline loopback benchmark. Finite synthetic provider; no secrets or external fetch. */
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync,rmSync,readFileSync,writeFileSync,readdirSync,mkdirSync } from 'node:fs';
import { tmpdir,cpus,platform,release } from 'node:os';
import { join,basename } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createHash,randomBytes } from 'node:crypto';
import { fixture,FIXTURE_TIME } from './testing.ts';
import { type ModelRequest,type ExecutionGrant } from './contracts.ts';
import { directProvider } from './direct-provider.ts';
import { ManagedGateway } from './gateway.ts';
import { BillingService } from './billing.ts';
import { createGatewayServer } from './http.ts';
import { LedgerDatabase } from './database.ts';
import { UsageLedger } from './ledger.ts';
import { digest } from './ledger.ts';
const dir=mkdtempSync(join(tmpdir(),'realbud-benchmark-'));
const destination=new URL('./evidence/phase2/latency.json',import.meta.url);
const requestBase:ModelRequest={model:'fixture-text',rateVersion:'fixture-r1',idempotencyKey:'bench',protocol:'tools-v1',tools:[{type:'function',function:{name:'read_record',parameters:{type:'object'}}}],thinking:'enabled',messages:[{role:'user',content:'Read two FICTIONAL records and summarise.'}],maxOutputTokens:20};
let serial=0;
const mockProvider=directProvider({provider:'kimi',model:'fixture-text',upstreamModel:'kimi-k3',enforcedContextTokens:100,maximumOutputTokens:20,terms:{reviewReference:'synthetic-benchmark-only',approvedUntil:FIXTURE_TIME+86400000},secret:async()=>'synthetic-not-a-key',fetch:(async(_url,init)=>{
  const payload=JSON.parse(String(init?.body)),tools=payload.messages.filter((m:{role:string})=>m.role==='tool').length,call=++serial;
  const frame=(delta:unknown,finish_reason:string|null=null,usage?:unknown)=>`data: ${JSON.stringify({id:`bench-${call}`,model:'kimi-k3',choices:[{index:0,delta,finish_reason}],...(usage?{usage}:{})})}\n\n`;
  let timer:ReturnType<typeof setTimeout>|undefined;
  const chunks=[frame({role:'assistant',reasoning_content:'synthetic continuation'}),frame({content:'Useful fixture text. '}),tools<2?frame({tool_calls:[{index:0,id:`tool-${tools}`,type:'function',function:{name:'read_record',arguments:'{}'}}]},'tool_calls',{prompt_tokens:15,completion_tokens:4,total_tokens:19,cached_tokens:5}):frame({content:'Complete.'},'stop',{prompt_tokens:15,completion_tokens:4,total_tokens:19,cached_tokens:5}),'data: [DONE]\n\n'];
  return new Response(new ReadableStream({start(controller){let n=0;const send=()=>{if(n===chunks.length){controller.close();return;}controller.enqueue(new TextEncoder().encode(chunks[n++]));timer=setTimeout(send,4);};timer=setTimeout(send,2);},cancel(){if(timer)clearTimeout(timer);}}),{headers:{'content-type':'text/event-stream'}});
}) as typeof fetch});
const failures:{scenario:string;message:string}[]=[];
type Sample={firstMeaningfulMs:number;completionMs:number;workflowMs:number};
const stats=(samples:number[])=>{const sorted=[...samples].sort((a,b)=>a-b);return {n:samples.length,mean:samples.reduce((a,b)=>a+b,0)/samples.length,p50:sorted[Math.ceil(sorted.length*.5)-1],p95:sorted[Math.ceil(sorted.length*.95)-1]};};
const summarize=(samples:Sample[])=>({firstMeaningfulMs:stats(samples.map(s=>s.firstMeaningfulMs)),completionMs:stats(samples.map(s=>s.completionMs)),workflowMs:stats(samples.map(s=>s.workflowMs))});
async function listen(server:ReturnType<typeof createServer>){server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();if(typeof address==='string' || !address)throw Error('no address');return `http://127.0.0.1:${address.port}/v1/model/stream`;}
async function stop(server:ReturnType<typeof createServer>){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
const scenarios:unknown[]=[];const startup:unknown[]=[];
try {
  for(const seed of [0,1000]) {
    const path=join(dir,`ledger-${seed}.sqlite`),f=fixture(path);
    for(let n=0;n<seed;n++) {const g=f.grant(f.request,{attemptId:`seed-${n}`,jti:`seed-${n}`});const r=f.ledger.reserve(g,'fixture-host-key',`fp-${n}`,`seed-${n}`,f.provider.bound(f.request)).record;f.ledger.dispatch(r.id,g,f.provider.id);f.ledger.settle(r.id,f.provider.id,f.evidence({evidenceId:`seed-${n}`,providerRequestId:`seed-${n}`}));}
    f.close();
    const openTimes:number[]=[];for(let n=0;n<6;n++){const start=performance.now(),db=new LedgerDatabase(path);openTimes.push(performance.now()-start);db.close();}
    startup.push({seedRequests:seed,kind:'database reopen in a warm process; includes schema check and ledger hash verification; excludes OS-cold/process-cold startup',milliseconds:stats(openTimes)});
    const db=new LedgerDatabase(path),ledger=new UsageLedger(db,()=>FIXTURE_TIME),gateway=new ManagedGateway({ledger,routes:new Map([['fixture-text',mockProvider]]),authority:f.authority,fingerprintKey:randomBytes(32)});
    const service=createGatewayServer({gateway,billing:new BillingService(ledger),portal:{async authenticate(){throw Error('not part of benchmark');}},allowedOrigins:new Set()});
    const direct=createServer(async(req,res)=>{try{const data:Buffer[]=[];for await(const chunk of req)data.push(Buffer.from(chunk));const request:ModelRequest=JSON.parse(Buffer.concat(data).toString());res.writeHead(200,{'content-type':'text/event-stream'});for await(const event of mockProvider.stream(request,{dispatchId:'direct-benchmark',signal:new AbortController().signal})){if(event.type==='delta')res.write(`event: delta\ndata: ${JSON.stringify({text:event.text})}\n\n`);if(event.type==='continuation')res.write(`event: continuation\ndata: ${JSON.stringify({message:event.message})}\n\n`);}res.end();}catch{res.writeHead(500);res.end();}});
    const gatewayUrl=await listen(service),directUrl=await listen(direct);let workflowSerial=0;
    async function workflow(mode:'direct'|'gateway'):Promise<Sample> {
      const attempt=`benchmark-${seed}-${++workflowSerial}`,start=performance.now();let request:ModelRequest={...requestBase,messages:[...requestBase.messages]},firstMeaningfulMs=0,completionMs=0;
      for(let call=0;call<3;call++) {
        request={...request,idempotencyKey:`${attempt}-${call}`};
        const grant:ExecutionGrant=f.grant(request,{schema:2,grantVersion:2,attemptId:attempt,jti:`${attempt}-${call}`,modelCallId:`call-${call}`,provider:'kimi',allowedModels:[{provider:'kimi',model:request.model,capabilities:['text','tools']}],maxAttemptSpendNanoAud:'1000000000',attemptExpiresAt:FIXTURE_TIME+120000,requestDigest:digest(request)});
        const body=JSON.stringify(request),bearer=Buffer.from(JSON.stringify(f.envelope(grant))).toString('base64url');
        const sent=performance.now();const response=await fetch(mode==='gateway'?gatewayUrl:directUrl,{method:'POST',headers:{'content-type':'application/json',Authorization:`Bearer ${bearer}`},body});if(!response.ok)throw Error(`HTTP ${response.status}`);let buffer='',first:number|undefined,message:ModelRequest['messages'][number]|undefined;const decoder=new TextDecoder();
        const reader=response.body!.getReader();while(true){const part=await reader.read();if(part.done)break;buffer+=decoder.decode(part.value,{stream:true});let end:number;while((end=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);const type=frame.split('\n').find(l=>l.startsWith('event: '))?.slice(7),data=JSON.parse(frame.split('\n').find(l=>l.startsWith('data: '))!.slice(6));if(type==='delta' && data.text && first===undefined)first=performance.now()-sent;if(type==='error')throw Error(`gateway ${data.code}`);if(type==='continuation')message=data.message;}}
        if(first===undefined || !message)throw Error('missing successful meaningful output');if(call===0){firstMeaningfulMs=first;completionMs=performance.now()-sent;}
        request={...request,messages:[...request.messages,message,...(call<2?[{role:'tool' as const,content:'FICTIONAL RESULT',tool_call_id:`tool-${call}`}]:[])]};
      }
      return {firstMeaningfulMs,completionMs,workflowMs:performance.now()-start};
    }
    try {
      // First request uses fresh servers/sockets, but this JS process/OS cache is already warm.
      const firstDirect=await workflow('direct'),firstGateway=await workflow('gateway');startup.push({seedRequests:seed,kind:'first workflow on new HTTP servers in warm process',direct:firstDirect,gateway:firstGateway});
      for(const concurrency of [1,2,4]) {
        const before=ledger.requests(f.tenant.companyId).length;const samples={direct:[] as Sample[],gateway:[] as Sample[]};
        for(let warmup=0;warmup<6;warmup++)await Promise.all(Array.from({length:concurrency},()=>workflow(warmup%2?'direct':'gateway')));
        // Alternate route order per batch to limit drift; samples compare matched mock workloads.
        for(let batch=0;batch<24/concurrency;batch++)for(const mode of (batch%2?['gateway','direct']:['direct','gateway']) as ('gateway'|'direct')[]) {
          const result=await Promise.allSettled(Array.from({length:concurrency},()=>workflow(mode)));
          for(const sample of result)if(sample.status==='fulfilled')samples[mode].push(sample.value);else failures.push({scenario:`seed=${seed}, concurrency=${concurrency}, mode=${mode}`,message:String(sample.reason)});
        }
        const d=summarize(samples.direct),g=summarize(samples.gateway);scenarios.push({seedRequests:seed,requestsBeforeWarmup:before,requestsAfter:ledger.requests(f.tenant.companyId).length,concurrency,warmupBatches:6,measuredWorkflowsPerRoute:24,modelCallsPerWorkflow:3,direct:d,gateway:g,addedMs:{firstMeaningfulMean:g.firstMeaningfulMs.mean-d.firstMeaningfulMs.mean,firstMeaningfulP95Difference:g.firstMeaningfulMs.p95-d.firstMeaningfulMs.p95,completionMean:g.completionMs.mean-d.completionMs.mean,completionP95Difference:g.completionMs.p95-d.completionMs.p95,workflowMean:g.workflowMs.mean-d.workflowMs.mean,workflowP95Difference:g.workflowMs.p95-d.workflowMs.p95},pairedOverheadMs:{firstMeaningful:stats(samples.gateway.map((s,i)=>s.firstMeaningfulMs-samples.direct[i].firstMeaningfulMs)),completion:stats(samples.gateway.map((s,i)=>s.completionMs-samples.direct[i].completionMs)),workflow:stats(samples.gateway.map((s,i)=>s.workflowMs-samples.direct[i].workflowMs))},raw:samples});
      }
      db.verify();if(ledger.requests(f.tenant.companyId).some(r=>r.state!=='settled'))throw Error('unsettled benchmark request');
    }finally{await stop(service);await stop(direct);db.close();}
  }
  const root=new URL('./',import.meta.url);const manifest=Object.fromEntries(readdirSync(root).filter(name=>name.endsWith('.ts') && !name.endsWith('.test.ts')).sort().map(name=>[name,createHash('sha256').update(readFileSync(new URL(name,root))).digest('hex')]));
  const report={schema:1,measuredAt:new Date().toISOString(),scope:'Offline HTTP loopback, injected timed SSE provider, authenticated v2 gateway and durable SQLite WAL/FULL ledger. No real provider, deployment, office channel or Square calls.',host:{node:process.version,platform:platform(),release:release(),cpu:cpus()[0].model},method:{meaningful:'first non-empty content delta, excluding reservation and reasoning',completion:'first model call response end including continuation and settlement',workflow:'three sequential signed child calls with full preserved reasoning/tool replies; includes client signing and JSON work',warmup:'six batches per concurrency, alternating direct/gateway',coldLimit:'No process-cold or OS-cache-cold measurement; first-server and database-reopen measurements are labelled separately',pairedP95:'pairedOverheadMs pairs samples by matching batch position across alternating route runs; differences of route p95 are separately labelled; pairs are sequential, not simultaneous',throughput:'Not inferred from short synthetic timer chunks; matched live token-throughput measurement remains required',seed:'Real synthetic settled request/evidence/event rows, not empty filler',square:'Separate class with no gateway import or call'},startup,scenarios,failures,manifest};
  mkdirSync(new URL('./evidence/phase2/',import.meta.url),{recursive:true});writeFileSync(destination,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({artifact:basename(destination.pathname),scenarios:scenarios.map(s=>{const r=s as Record<string,unknown>;return {seed:r.seedRequests,concurrency:r.concurrency,addedMs:r.addedMs};}),failures},null,2));
  if(failures.length)process.exitCode=1;
}finally{rmSync(dir,{recursive:true,force:true});}
