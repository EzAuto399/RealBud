// The wire is the product's public face, so its refusals matter as much as its
// mappings: a parameter the service cannot honour must be REFUSED by name, not
// silently dropped. These tests pin both directions — parsing and framing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChatCompletionStream,
  completionBody,
  modelsBody,
  openAIErrorBody,
  openAIUsage,
  parseChatRequest,
} from './openai.ts';
import type { ToolCall } from './messages.ts';

const toolCall: ToolCall = { id: 'call_1', type: 'function', function: { name: 'lookup_contact', arguments: '{"address":"12 Banksia Ct"}' } };
const toolDef = { type: 'function', function: { name: 'lookup_contact', parameters: { type: 'object' } } };

test('parses a minimal chat request and leaves the service decisions open', () => {
  const parsed = parseChatRequest({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(parsed.model, 'deepseek-chat');
  assert.equal(parsed.stream, false);
  assert.equal(parsed.includeUsage, false);
  assert.equal(parsed.maxOutputTokens, undefined);
  assert.equal(parsed.tools, undefined);
  assert.deepEqual(parsed.messages, [{ role: 'user', content: 'hi' }]);
  assert.equal('auto' === 'auto', true); // `auto` is a legal model string; resolution is the service's job
  assert.equal(parseChatRequest({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }).model, 'auto');
});

test('refuses unknown top-level parameters by name — nothing is silently dropped', () => {
  assert.throws(() => parseChatRequest({ model: 'm', messages: [{ role: 'user', content: 'x' }], temperature: 0.2 }), /unsupported_parameter:temperature/);
  assert.throws(() => parseChatRequest({ model: 'm', messages: [{ role: 'user', content: 'x' }], n: 2 }), /unsupported_parameter:n/);
});

test('honours one output limit form and refuses ambiguity', () => {
  assert.equal(parseChatRequest({ model: 'm', messages: [{ role: 'user', content: 'x' }], max_completion_tokens: 512 }).maxOutputTokens, 512);
  assert.equal(parseChatRequest({ model: 'm', messages: [{ role: 'user', content: 'x' }], max_tokens: 100 }).maxOutputTokens, 100);
  assert.throws(() => parseChatRequest({ model: 'm', messages: [{ role: 'user', content: 'x' }], max_tokens: 1, max_completion_tokens: 2 }), /ambiguous_output_limit/);
  assert.throws(() => parseChatRequest({ model: 'm', messages: [{ role: 'user', content: 'x' }], max_tokens: 0 }), /invalid_output_limit/);
  assert.throws(() => parseChatRequest({ model: 'm', messages: [{ role: 'user', content: 'x' }], max_tokens: 1.5 }), /invalid_integer/);
});

test('converts a tool conversation and validates it with the shared validators', () => {
  const parsed = parseChatRequest({
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'Look them up.' },
      { role: 'assistant', content: null, tool_calls: [toolCall] },
      { role: 'tool', content: '{"found":true}', tool_call_id: 'call_1' },
    ],
    tools: [toolDef],
  });
  assert.equal(parsed.tools?.length, 1);
  assert.deepEqual(parsed.messages[2], { role: 'assistant', content: null, tool_calls: [toolCall] });
  assert.deepEqual(parsed.messages[3], { role: 'tool', content: '{"found":true}', tool_call_id: 'call_1' });
});

test('tool history requires the tools array — no half-specified loops', () => {
  const conversation = [
    { role: 'user', content: 'x' },
    { role: 'assistant', content: null, tool_calls: [toolCall] },
  ];
  assert.throws(() => parseChatRequest({ model: 'm', messages: conversation }), /tools_required_for_tool_history/);
  assert.throws(() => parseChatRequest({ model: 'm', messages: conversation, tools: [] }), /tools_required_for_tool_history/);
});

test('content parts are refused, not approximated', () => {
  assert.throws(() => parseChatRequest({ model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }), /unsupported_content_parts/);
});

test('unsupported roles and stray message fields are refused', () => {
  assert.throws(() => parseChatRequest({ model: 'm', messages: [{ role: 'developer', content: 'x' }] }), /unsupported_message_role/);
  assert.throws(() => parseChatRequest({ model: 'm', messages: [{ role: 'user', content: 'x', name: 'bob' }] }), /unsupported_parameter:messages.name/);
});

test('tool replies must carry a call id, and every call needs its reply', () => {
  assert.throws(() => parseChatRequest({
    model: 'm',
    messages: [{ role: 'user', content: 'x' }, { role: 'tool', content: '{}' }],
    tools: [toolDef],
  }), /invalid_tool_call_id/);
  assert.throws(() => parseChatRequest({
    model: 'm',
    messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: null, tool_calls: [toolCall] }],
    tools: [toolDef],
  }), /missing_tool_reply/);
});

test('tool_choice: auto passes; anything else is refused until the service can honour it', () => {
  const base = { model: 'm', messages: [{ role: 'user', content: 'x' }], tools: [toolDef] };
  assert.equal(parseChatRequest({ ...base, tool_choice: 'auto' }).tools?.length, 1);
  assert.throws(() => parseChatRequest({ ...base, tool_choice: 'none' }), /unsupported_tool_choice/);
  assert.throws(() => parseChatRequest({ ...base, tool_choice: 'required' }), /unsupported_tool_choice/);
});

test('stream_options controls the usage chunk; unknown keys are refused', () => {
  const base = { model: 'm', messages: [{ role: 'user', content: 'x' }] };
  assert.equal(parseChatRequest({ ...base, stream_options: { include_usage: true } }).includeUsage, true);
  assert.equal(parseChatRequest({ ...base, stream_options: { include_usage: false } }).includeUsage, false);
  assert.throws(() => parseChatRequest({ ...base, stream_options: { weird: 1 } }), /unsupported_parameter:stream_options.weird/);
  assert.throws(() => parseChatRequest({ ...base, stream_options: { include_usage: 'yes' } }), /invalid_stream_options/);
});

test('user is accepted and inert; oversized values are refused', () => {
  const base = { model: 'm', messages: [{ role: 'user', content: 'x' }] };
  assert.equal(parseChatRequest({ ...base, user: 'end-user-1' }).model, 'm');
  assert.throws(() => parseChatRequest({ ...base, user: 'x'.repeat(257) }), /invalid_user/);
});

test('openAIUsage pairs disjoint internal units with inclusive prompt tokens', () => {
  assert.deepEqual(openAIUsage({ input_tokens: 100, cache_read_tokens: 25, output_tokens: 7 }), {
    prompt_tokens: 125,
    completion_tokens: 7,
    total_tokens: 132,
    prompt_tokens_details: { cached_tokens: 25 },
  });
  assert.deepEqual(openAIUsage({ input_tokens: 10, output_tokens: 2 }), {
    prompt_tokens: 10,
    completion_tokens: 2,
    total_tokens: 12,
  });
});

test('completionBody carries content, tool calls, finish reason and usage', () => {
  const meta = { id: 'chatcmpl-1', created: 123, model: 'deepseek/deepseek-chat' };
  const body = completionBody(meta, { content: 'hi', finishReason: 'stop', usage: { input_tokens: 1, output_tokens: 2 } });
  assert.equal(body.object, 'chat.completion');
  assert.equal(body.model, 'deepseek/deepseek-chat');
  assert.deepEqual(body.choices[0].message, { role: 'assistant', content: 'hi' });
  assert.equal(body.choices[0].finish_reason, 'stop');
  assert.equal(body.usage?.total_tokens, 3);

  const toolBody = completionBody(meta, { content: null, toolCalls: [toolCall], finishReason: 'tool_calls' });
  assert.equal(toolBody.choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(toolBody.choices[0].message.tool_calls, [toolCall]);
});

test('stream frames follow the OpenAI chunk sequence and end with DONE', () => {
  const stream = new ChatCompletionStream({ id: 'chatcmpl-1', created: 5, model: 'm' }, true);
  const raw = [stream.start(), stream.content('He'), stream.content('llo'), ...stream.finish({ finishReason: 'stop' }), ...stream.usage({ input_tokens: 1, output_tokens: 2 }), stream.done()];
  const parsed = raw.map((frame) => frame === 'data: [DONE]\n\n' ? '[DONE]' : JSON.parse(frame.replace(/^data: /, '').replace(/\n\n$/, '')));
  assert.equal(parsed[0].choices[0].delta.role, 'assistant');
  assert.equal(parsed[1].choices[0].delta.content, 'He');
  assert.equal(parsed[2].choices[0].delta.content, 'llo');
  assert.deepEqual(parsed[3].choices[0].delta, {});
  assert.equal(parsed[3].choices[0].finish_reason, 'stop');
  assert.equal(parsed[4].choices.length, 0);
  assert.equal(parsed[4].usage.total_tokens, 3);
  assert.equal(parsed[5], '[DONE]');

  const quiet = new ChatCompletionStream({ id: 'x', created: 0, model: 'm' }, false);
  assert.deepEqual(quiet.usage({ input_tokens: 1 }), []);
});

test('stream finish with tool calls emits one whole-call delta before the finish reason', () => {
  const stream = new ChatCompletionStream({ id: 'chatcmpl-2', created: 0, model: 'm' }, false);
  const frames = stream.finish({ toolCalls: [toolCall], finishReason: 'tool_calls' }).map((frame) => JSON.parse(frame.replace(/^data: /, '').replace(/\n\n$/, '')));
  assert.equal(frames.length, 2);
  assert.equal(frames[0].choices[0].delta.tool_calls[0].index, 0);
  assert.equal(frames[0].choices[0].delta.tool_calls[0].function.name, 'lookup_contact');
  assert.equal(frames[0].choices[0].finish_reason, null);
  assert.equal(frames[1].choices[0].finish_reason, 'tool_calls');
});

test('modelsBody lists only what it is given', () => {
  const body = modelsBody(['auto', 'deepseek-chat'], 42);
  assert.equal(body.object, 'list');
  assert.deepEqual(body.data.map((m) => m.id), ['auto', 'deepseek-chat']);
  assert.equal(body.data[0].object, 'model');
  assert.equal(body.data[0].created, 42);
});

test('openAIErrorBody is an OpenAI-shaped error', () => {
  assert.deepEqual(openAIErrorBody('boom', 'invalid_model'), {
    error: { message: 'boom', type: 'invalid_request_error', code: 'invalid_model', param: null },
  });
  assert.equal(openAIErrorBody('nope', 'invalid_key', 'authentication_error').error.type, 'authentication_error');
});
