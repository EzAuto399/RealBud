import { canonical, exact, object, requireThat, type ModelRequest } from './contracts.ts';
export interface ToolCall { id:string; type:'function'; function:{name:string;arguments:string} }
export interface AssistantMessage { role:'assistant'; content:string|null; reasoning_content?:string; tool_calls?:ToolCall[] }
export type ModelMessage = {role:'system'|'user';content:string} | AssistantMessage | {role:'tool';content:string;tool_call_id:string};
export interface ToolDefinition {type:'function';function:{name:string;description?:string;parameters:Record<string,unknown>}}
const shortString=(v:unknown,max=200_000)=>requireThat(typeof v==='string' && v.length<=max,'invalid_message_text');
export function validateAssistant(value:unknown):asserts value is AssistantMessage {
  object(value); exact(value,['role','content',...(['reasoning_content','tool_calls'].filter(k=>Object.hasOwn(value,k)))]);
  requireThat(value.role==='assistant' && (typeof value.content==='string' || value.content===null),'invalid_assistant');
  if(value.content!==null)shortString(value.content);
  if(Object.hasOwn(value,'reasoning_content'))shortString(value.reasoning_content);
  if(value.tool_calls!==undefined) {
    requireThat(Array.isArray(value.tool_calls) && value.tool_calls.length>0 && value.tool_calls.length<=64,'invalid_tool_calls');
    const ids=new Set<string>();
    for(const call of value.tool_calls) {
      object(call);exact(call,['id','type','function']);shortString(call.id,160);requireThat(typeof call.id==='string' && call.id.length>0 && !ids.has(call.id) && call.type==='function','invalid_tool_call');ids.add(call.id);
      object(call.function);exact(call.function,['name','arguments']);shortString(call.function.name,128);shortString(call.function.arguments);
      requireThat(typeof call.function.name==='string' && /^[a-zA-Z0-9_-]{1,128}$/.test(call.function.name),'invalid_tool_name');
      try {object(JSON.parse(String(call.function.arguments)));} catch {requireThat(false,'invalid_tool_arguments');}
    }
  }
}
export function validateMessages(request:ModelRequest) {
  let pending=new Set<string>(); const allIds=new Set<string>();
  for(const raw of request.messages) {
    const message:unknown=raw; object(message);
    if(request.protocol!=='tools-v1') {exact(message,['role','content']);requireThat(['system','user','assistant'].includes(String(message.role)),'unsupported_message');shortString(message.content);continue;}
    if(message.role==='tool') {
      exact(message,['role','content','tool_call_id']);shortString(message.content);
      requireThat(typeof message.tool_call_id==='string' && pending.delete(message.tool_call_id),'unexpected_tool_reply');continue;
    }
    requireThat(pending.size===0,'missing_tool_reply');
    if(message.role==='assistant') {
      validateAssistant(message);
      for(const call of message.tool_calls??[]) {requireThat(!allIds.has(call.id),'duplicate_tool_call');pending.add(call.id);allIds.add(call.id);}
    } else {exact(message,['role','content']);requireThat(['system','user'].includes(String(message.role)),'unsupported_message');shortString(message.content);}
  }
  requireThat(pending.size===0,'missing_tool_reply');
  if(request.protocol==='tools-v1') {
    requireThat(Array.isArray(request.tools) && request.tools.length<=64,'invalid_tools');const names=new Set<string>();
    for(const tool of request.tools) {
      object(tool);exact(tool,['type','function']);requireThat(tool.type==='function','unsupported_tool_type');object(tool.function);
      exact(tool.function,['name','parameters',...(Object.hasOwn(tool.function,'description')?['description']:[])]);
      requireThat(typeof tool.function.name==='string' && /^[a-zA-Z0-9_-]{1,128}$/.test(tool.function.name) && !names.has(tool.function.name),'invalid_tool_name');names.add(tool.function.name);
      object(tool.function.parameters);if(tool.function.description!==undefined)shortString(tool.function.description,10000);
    }
    requireThat(['enabled','disabled'].includes(String(request.thinking)) && (request.reasoningEffort===undefined || ['low','high','max'].includes(request.reasoningEffort)),'invalid_thinking_mode');
  }
  requireThat(Buffer.byteLength(canonical(request))<=1_000_000,'request_too_large',413);
}
