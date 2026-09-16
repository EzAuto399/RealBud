import { integer, object, requireThat, type ModelRequest, type ProviderAdapter, type ProviderEvent, type Units } from './contracts.ts';

export interface OpenAITextRoute {
  /** Explicit pinned model, verified limits and dated upstream terms admission; no defaults. */
  model: string; upstreamModel: string; maximumInputTokens:number; maximumOutputTokens:number;
  terms: ProviderAdapter['terms']; secret:()=>Promise<string>; fetch?:typeof fetch;
}
/** Bounded text-only OpenAI adapter. No arbitrary URL, tools, images, audio, n>1 or
 * upstream account fields. Other protocols require their own verified adapter. */
export function openAITextProvider(config:OpenAITextRoute):ProviderAdapter {
  integer(config.maximumInputTokens,10_000_000); integer(config.maximumOutputTokens,1_000_000);
  requireThat(config.maximumInputTokens>0 && config.maximumOutputTokens>0 && config.upstreamModel.length>0,'invalid_model_limits');
  return {
    id:`openai-text/${config.upstreamModel}`,usageNamespace:'openai',terms:config.terms,
    bound(request:ModelRequest):Units {
      requireThat(!request.protocol && request.model===config.model && request.maxOutputTokens<=config.maximumOutputTokens,'unsupported_model_request');
      // Full admitted context bound includes message framing. Reserve cached AND uncached maxima
      // conservatively because cache hits are unknown until final provider usage arrives.
      return {input_tokens:config.maximumInputTokens,cache_read_tokens:config.maximumInputTokens,output_tokens:request.maxOutputTokens};
    },
    async *stream(request,context):AsyncIterable<ProviderEvent> {
      requireThat(config.fetch,'external_transport_disabled',503);
      const secret=await config.secret(); requireThat(secret.length>0,'provider_secret_unavailable',503);
      context.signal.throwIfAborted();
      const response=await config.fetch('https://api.openai.com/v1/chat/completions',{
        method:'POST',redirect:'error',signal:context.signal,
        headers:{'Content-Type':'application/json',Authorization:`Bearer ${secret}`,'X-Client-Request-Id':context.dispatchId},
        body:JSON.stringify({model:config.upstreamModel,messages:request.messages,max_completion_tokens:request.maxOutputTokens,stream:true,stream_options:{include_usage:true},store:false,n:1}),
      });
      // No automatic retry, including 429/5xx/timeouts. Body can contain private provider details.
      if (!response.ok) { await response.body?.cancel(); requireThat(false,'provider_request_failed',502); }
      requireThat(response.body && response.headers.get('content-type')?.includes('text/event-stream'),'invalid_provider_response',502);
      const reader=response.body.getReader(), decoder=new TextDecoder(); let buffer='',total=0,done=false,seenUsage=false,upstreamId='';
      const cancel=()=>{ void reader.cancel().catch(()=>{}); }; context.signal.addEventListener('abort',cancel,{once:true});
      try {
        while (!done) {
          context.signal.throwIfAborted(); const chunk=await reader.read(); if(chunk.done) break;
          total+=chunk.value.byteLength; requireThat(total<=16_000_000,'provider_stream_too_large',502);
          buffer=(buffer+decoder.decode(chunk.value,{stream:true})).replace(/\r\n/g,'\n'); requireThat(buffer.length<=1_000_000,'provider_event_too_large',502);
          let end:number;
          while((end=buffer.indexOf('\n\n'))>=0) {
            const frame=buffer.slice(0,end); buffer=buffer.slice(end+2);
            const data=frame.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');
            if(!data) continue;
            if(data==='[DONE]') { done=true; break; }
            let event:unknown; try { event=JSON.parse(data); } catch { requireThat(false,'invalid_provider_event',502); }
            object(event); requireThat(!event.error && !seenUsage,'invalid_provider_event',502);
            requireThat(typeof event.id==='string' && /^[A-Za-z0-9_-]{1,160}$/.test(event.id),'missing_provider_request_id',502);
            if(!upstreamId) upstreamId=event.id; requireThat(upstreamId===event.id,'provider_request_id_changed',502);
            if (event.usage) {
              object(event.usage); const usage=event.usage;
              requireThat(Object.keys(usage).every(k=>['prompt_tokens','completion_tokens','total_tokens','prompt_tokens_details','completion_tokens_details'].includes(k)),'unsupported_usage_schema',502);
              integer(usage.prompt_tokens); integer(usage.completion_tokens); integer(usage.total_tokens);
              requireThat(usage.prompt_tokens+usage.completion_tokens===usage.total_tokens,'inconsistent_provider_usage',502);
              let cached=0;
              if(usage.prompt_tokens_details != null) { object(usage.prompt_tokens_details); if(usage.prompt_tokens_details.cached_tokens != null) { integer(usage.prompt_tokens_details.cached_tokens); cached=usage.prompt_tokens_details.cached_tokens; } }
              requireThat(cached<=usage.prompt_tokens,'invalid_cached_usage',502);
              // Reasoning tokens are already included in completion_tokens. Unsupported billable
              // modalities fail closed even if an upstream response unexpectedly contains them.
              for(const details of [usage.prompt_tokens_details,usage.completion_tokens_details]) if(details) {
                object(details); requireThat(Object.keys(details).every(k=>['cached_tokens','audio_tokens','reasoning_tokens','accepted_prediction_tokens','rejected_prediction_tokens'].includes(k)),'unsupported_usage_schema',502);
                for(const value of Object.values(details)) integer(value);
                for(const key of ['audio_tokens','accepted_prediction_tokens','rejected_prediction_tokens']) if(details[key]!=null) requireThat(details[key]===0,'unsupported_billable_unit',502);
              }
              seenUsage=true;
              yield {type:'usage',evidence:{evidenceId:`final-${upstreamId}`,providerRequestId:upstreamId,units:{input_tokens:usage.prompt_tokens-cached,cache_read_tokens:cached,output_tokens:usage.completion_tokens},outcome:'succeeded',source:'final_usage'}};
            }
            requireThat(Array.isArray(event.choices) && event.choices.length<=1,'invalid_provider_choices',502);
            for(const choice of event.choices) {
              object(choice); object(choice.delta); requireThat(!choice.delta.tool_calls && !choice.delta.audio,'unsupported_provider_output',502);
              if(choice.delta.content != null) { requireThat(typeof choice.delta.content==='string','invalid_provider_text',502); yield {type:'delta',text:choice.delta.content}; }
            }
          }
        }
        requireThat(done && seenUsage,'incomplete_provider_usage',502);
      } finally { context.signal.removeEventListener('abort',cancel); await reader.cancel().catch(()=>{}); reader.releaseLock(); }
    },
  };
}
