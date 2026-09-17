import { id, integer, object, requireThat, type ProviderAdapter, type ProviderEvent, type Units } from './contracts.ts';
import { validateRequest } from './auth.ts';
import { validateAssistant, type AssistantMessage, type ToolCall } from './messages.ts';
import { abortable } from './abort.ts';

export interface DirectProviderConfig {
  provider:'deepseek'|'kimi'; model:string; upstreamModel:string; maximumOutputTokens:number;
  /** The provider-enforced complete context ceiling, including framing/tools/thinking.
   * No character/token estimate. Smaller ceilings need a verified tokenizer before admission. */
  enforcedContextTokens:number;
  terms:ProviderAdapter['terms']; secret:()=>Promise<string>;
  /** Absent means disabled, including secret access. This slice supplies mocks only. */
  fetch?:typeof fetch;
}
const ENDPOINTS={deepseek:'https://api.deepseek.com/chat/completions',kimi:'https://api.moonshot.ai/v1/chat/completions'};
export function directProvider(config:DirectProviderConfig):ProviderAdapter {
  id(config.model);id(config.upstreamModel);integer(config.enforcedContextTokens,10_000_000);integer(config.maximumOutputTokens,1_000_000);
  requireThat(config.enforcedContextTokens>0 && config.maximumOutputTokens>0 && (config.provider!=='kimi' || config.upstreamModel==='kimi-k3'),'unsupported_direct_model');
  return {
    id:`${config.provider}/${config.upstreamModel}`,usageNamespace:config.provider,terms:config.terms,
    bound(request):Units {
      validateRequest(request);requireThat(request.model===config.model && request.protocol==='tools-v1' && request.maxOutputTokens<=config.maximumOutputTokens,'unsupported_model_request');
      requireThat(config.provider!=='kimi' || request.thinking==='enabled','kimi_thinking_required');
      requireThat(config.provider!=='deepseek' || request.reasoningEffort===undefined,'unsupported_thinking_effort');
      for(const m of request.messages)if(config.provider==='deepseek' && m.role==='assistant' && m.tool_calls?.length)requireThat(typeof m.content==='string','deepseek_assistant_content_required');
      for(const m of request.messages)if(m.role==='assistant' && (config.provider==='kimi' || (request.thinking==='enabled' && !!request.tools?.length))) requireThat(typeof m.reasoning_content==='string','thinking_history_required');
      return {input_tokens:config.enforcedContextTokens,cache_read_tokens:config.enforcedContextTokens,output_tokens:request.maxOutputTokens};
    },
    async *stream(request,context):AsyncIterable<ProviderEvent> {
      requireThat(config.fetch,'external_transport_disabled',503);
      const key=await abortable(config.secret(),context.signal);requireThat(key.length>0,'provider_secret_unavailable',503);context.signal.throwIfAborted();
      const body={model:config.upstreamModel,messages:request.messages,max_tokens:request.maxOutputTokens,stream:true,stream_options:{include_usage:true},...(request.tools?.length?{tools:request.tools}:{}),...(config.provider==='kimi'?{reasoning_effort:request.reasoningEffort??'max'}:{thinking:{type:request.thinking}})};
      const response=await abortable(config.fetch(ENDPOINTS[config.provider],{method:'POST',redirect:'error',signal:context.signal,headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify(body)}),context.signal);
      if(!response.ok){void response.body?.cancel().catch(()=>{});requireThat(false,'provider_request_failed',502);}
      requireThat(response.body && response.headers.get('content-type')?.includes('text/event-stream'),'invalid_provider_response',502);
      const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let buffer='',bytes=0,done=false,requestId='',finished=false,usage:Units|undefined;
      const message:AssistantMessage={role:'assistant',content:null};const calls=new Map<number,ToolCall>();
      try {
        while(!done) {
          const part=await abortable(reader.read(),context.signal);if(part.done)break;
          bytes+=part.value.byteLength;requireThat(bytes<=16_000_000,'provider_stream_too_large',502);
          buffer+=decoder.decode(part.value,{stream:true});requireThat(buffer.length<=1_000_000,'provider_frame_too_large',502);
          // Normalize only complete CRLF pairs; a pair may be split between network reads.
          buffer=buffer.replace(/\r\n/g,'\n');let end:number;
          while((end=buffer.indexOf('\n\n'))>=0) {
            const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);
            const data=frame.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');if(!data)continue;
            if(data==='[DONE]'){done=true;break;}
            let event:unknown;try{event=JSON.parse(data);}catch{requireThat(false,'invalid_provider_event',502);}object(event);
            requireThat(!event.error && !usage,'invalid_provider_event',502);id(event.id);
            if(!requestId)requestId=event.id;requireThat(event.id===requestId && event.model===config.upstreamModel,'provider_identity_changed',502);
            requireThat(Array.isArray(event.choices) && event.choices.length<=1,'invalid_choices',502);
            for(const c of event.choices) {
              object(c);requireThat(c.index===0 && !finished,'invalid_choice_sequence',502);object(c.delta);
              requireThat(Object.keys(c.delta).every(k=>['role','content','reasoning_content','tool_calls'].includes(k)),'unsupported_assistant_field',502);
              if(c.delta.role!==undefined)requireThat(c.delta.role==='assistant','invalid_assistant_role',502);
              for(const field of ['content','reasoning_content'] as const)if(c.delta[field]!=null) {
                requireThat(typeof c.delta[field]==='string','invalid_assistant_text',502);
                message[field]=(message[field]??'')+c.delta[field];requireThat(message[field]!.length<=200_000,'continuation_too_large',502);
                if(field==='content' && c.delta[field])yield {type:'delta',text:c.delta[field]};
              }
              if(c.delta.tool_calls!==undefined) {
                requireThat(Array.isArray(c.delta.tool_calls),'invalid_tool_delta',502);
                for(const delta of c.delta.tool_calls) {
                  object(delta);requireThat(Object.keys(delta).every(k=>['index','id','type','function'].includes(k)),'unsupported_tool_delta',502);integer(delta.index,63);
                  let call=calls.get(delta.index);
                  if(!call){requireThat(delta.index===calls.size && typeof delta.id==='string' && delta.type==='function','invalid_tool_start',502);call={id:delta.id,type:'function',function:{name:'',arguments:''}};calls.set(delta.index,call);}
                  else requireThat((delta.id===undefined || delta.id===call.id) && (delta.type===undefined || delta.type===call.type),'tool_identity_changed',502);
                  if(delta.function!==undefined){object(delta.function);requireThat(Object.keys(delta.function).every(k=>['name','arguments'].includes(k)),'unsupported_tool_field',502);for(const field of ['name','arguments'] as const)if(delta.function[field]!==undefined){requireThat(typeof delta.function[field]==='string','invalid_tool_fragment',502);call.function[field]+=delta.function[field];requireThat(call.function[field].length<=200_000,'tool_fragment_too_large',502);}}
                }
              }
              if(c.finish_reason!==null && c.finish_reason!==undefined){requireThat(['stop','tool_calls'].includes(String(c.finish_reason)),'incomplete_assistant',502);requireThat((c.finish_reason==='tool_calls')===(calls.size>0),'finish_reason_mismatch',502);finished=true;}
            }
            if(event.usage!==null && event.usage!==undefined){requireThat(finished,'premature_usage',502);usage=normalizeUsage(config.provider,event.usage);}
          }
        }
        requireThat(done && finished && usage,'incomplete_provider_usage',502);
        if(calls.size)message.tool_calls=[...calls.values()];
        validateAssistant(message);
        if(config.provider==='deepseek' && calls.size)requireThat(typeof message.content==='string','deepseek_assistant_content_required');
        for(const c of message.tool_calls??[])requireThat(request.tools?.some(t=>t.function.name===c.function.name),'unoffered_tool_call',502);
        if(config.provider==='kimi' || request.thinking==='enabled')requireThat(typeof message.reasoning_content==='string','missing_thinking_continuation',502);
        // Never persisted or logged. Gateway only returns this after settlement and current authority checks.
        yield {type:'continuation',message};
        yield {type:'usage',evidence:{evidenceId:`final-${requestId}`,providerRequestId:requestId,units:usage,outcome:'succeeded',source:'final_usage'}};
      } finally {void reader.cancel().catch(()=>{});}
    },
  };
}
function normalizeUsage(provider:'deepseek'|'kimi',value:unknown):Units {
  object(value);const allowed=['prompt_tokens','completion_tokens','total_tokens',...(provider==='deepseek'?['prompt_cache_hit_tokens','prompt_cache_miss_tokens','prompt_tokens_details','completion_tokens_details']:['cached_tokens'])];
  requireThat(Object.keys(value).every(k=>allowed.includes(k)),'unsupported_usage_schema',502);
  integer(value.prompt_tokens);integer(value.completion_tokens);integer(value.total_tokens);
  requireThat(value.prompt_tokens+value.completion_tokens===value.total_tokens,'inconsistent_provider_usage',502);
  const cached=provider==='deepseek'?value.prompt_cache_hit_tokens:value.cached_tokens;integer(cached);requireThat(cached<=value.prompt_tokens,'invalid_cached_usage',502);
  if(provider==='deepseek'){integer(value.prompt_cache_miss_tokens);requireThat(value.prompt_cache_miss_tokens+cached===value.prompt_tokens,'inconsistent_cached_usage',502);}
  if(provider==='deepseek')for(const [field,key,expected] of [['prompt_tokens_details','cached_tokens',cached],['completion_tokens_details','reasoning_tokens',value.completion_tokens]] as const) {
    if(value[field]!=null){object(value[field]);requireThat(Object.keys(value[field]).every(k=>k===key),'unsupported_usage_schema',502);if(value[field][key]!==undefined){integer(value[field][key]);requireThat(field==='prompt_tokens_details'?value[field][key]===expected:value[field][key]<=expected,'inconsistent_usage_details',502);}}
  }
  return {input_tokens:value.prompt_tokens-cached,cache_read_tokens:cached,output_tokens:value.completion_tokens};
}
