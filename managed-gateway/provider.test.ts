import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openAITextProvider } from './openai-provider.ts';
import { fixture } from './testing.ts';
import type { ProviderEvent } from './contracts.ts';
const delta={id:'chatcmpl-test',choices:[{index:0,delta:{content:'Hello'}}],usage:null};
const usage={id:'chatcmpl-test',choices:[],usage:{prompt_tokens:10,completion_tokens:4,total_tokens:14,prompt_tokens_details:{cached_tokens:3,audio_tokens:0},completion_tokens_details:{reasoning_tokens:2,audio_tokens:0,accepted_prediction_tokens:0,rejected_prediction_tokens:0}}};
function streamData(events:unknown[],done=true) { return events.map(e=>`data: ${JSON.stringify(e)}\r\n\r\n`).join('')+(done?'data: [DONE]\r\n\r\n':''); }
function response(data:string,chunkSize=1024) { const bytes=Buffer.from(data);let offset=0;return new Response(new ReadableStream<Uint8Array>({pull(c){if(offset>=bytes.length){c.close();return;}c.enqueue(bytes.subarray(offset,offset+chunkSize));offset+=chunkSize;}}),{headers:{'content-type':'text/event-stream'}}); }
test('OpenAI adapter uses explicit route, bounded output, upstream secret only and exact disjoint usage',async()=>{
  const f=fixture();try {
    let called:RequestInit|undefined;let url='';
    const provider=openAITextProvider({model:'fixture-text',upstreamModel:'pinned-fixture-model',maximumInputTokens:100,maximumOutputTokens:20,terms:f.provider.terms,secret:async()=>'synthetic-secret-only',fetch:async(u,init)=>{url=String(u);called=init;return response(streamData([delta,usage]),1);}});
    assert.deepEqual(provider.bound(f.request),{input_tokens:100,cache_read_tokens:100,output_tokens:20});
    const events:ProviderEvent[]=[];for await(const e of provider.stream(f.request,{signal:new AbortController().signal,dispatchId:'dispatch-test'}))events.push(e);
    assert.equal(url,'https://api.openai.com/v1/chat/completions');assert.equal(called!.redirect,'error');
    const body=JSON.parse(called!.body as string);assert.equal(body.model,'pinned-fixture-model');assert.equal(body.max_completion_tokens,20);assert.equal(body.store,false);assert.equal(body.stream_options.include_usage,true);
    assert.equal((called!.headers as Record<string,string>).Authorization,'Bearer synthetic-secret-only');
    const last=events.at(-1)!;assert.equal(last.type,'usage');if(last.type==='usage')assert.deepEqual(last.evidence.units,{input_tokens:7,cache_read_tokens:3,output_tokens:4});
    assert(!JSON.stringify(events).includes('synthetic-secret-only'));
  }finally{f.close();}
});
test('missing/extra/unsupported provider usage and truncated streams fail instead of estimating',async()=>{
  const f=fixture();try {
    const cases=[streamData([delta],false),streamData([delta]),streamData([delta,usage],false),streamData([usage,usage]),streamData([{...usage,usage:{...usage.usage,total_tokens:99}}]),streamData([{...usage,usage:{...usage.usage,prompt_tokens_details:{cached_tokens:99}}}]),streamData([{...usage,usage:{...usage.usage,unknown_units:1}}]),streamData([{...usage,usage:{...usage.usage,completion_tokens_details:{audio_tokens:1}}}])];
    for(const data of cases) {
      const p=openAITextProvider({model:f.request.model,upstreamModel:'fixture-pinned',maximumInputTokens:100,maximumOutputTokens:20,terms:f.provider.terms,secret:async()=>'fixture',fetch:async()=>response(data)});
      await assert.rejects(async()=>{for await(const _event of p.stream(f.request,{signal:new AbortController().signal,dispatchId:'one'})){ /* drain */ }});
    }
  }finally{f.close();}
});
test('upstream failures are not retried or echoed with provider account details',async()=>{
  const f=fixture();try{let calls=0;const p=openAITextProvider({model:f.request.model,upstreamModel:'fixture',maximumInputTokens:100,maximumOutputTokens:20,terms:f.provider.terms,secret:async()=>'fixture',fetch:async()=>{calls++;return new Response('private account details',{status:429});}});
    await assert.rejects(async()=>{for await(const _event of p.stream(f.request,{signal:new AbortController().signal,dispatchId:'one'})){}},/provider_request_failed/);assert.equal(calls,1);
  }finally{f.close();}
});
test('cancellation aborts a stuck transport read',async()=>{
  const f=fixture();try{let cancelled=false;const abort=new AbortController();const p=openAITextProvider({model:f.request.model,upstreamModel:'fixture',maximumInputTokens:100,maximumOutputTokens:20,terms:f.provider.terms,secret:async()=>'fixture',fetch:async()=>new Response(new ReadableStream({start(c){c.enqueue(Buffer.from(streamData([delta],false)));},cancel(){cancelled=true;}}),{headers:{'content-type':'text/event-stream'}})});
    await assert.rejects(async()=>{for await(const event of p.stream(f.request,{signal:abort.signal,dispatchId:'one'})){if(event.type==='delta')abort.abort();}});assert.equal(cancelled,true);
  }finally{f.close();}
});
