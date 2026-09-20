// The OpenAI-compatible wire: the managed service's public face.
//
// This module is deliberately PURE — parsing and formatting only. It answers
// one question in each direction:
//
//   * what did the client actually ask for?          → parseChatRequest
//   * what does an OpenAI-shaped client expect back? → completionBody,
//     ChatCompletionStream frames, modelsBody, openAIErrorBody
//
// Nothing here decides WHICH model serves, what it costs, or whether admission
// is allowed; that belongs to the service and the ledger, exactly as it does
// for the signed-grant path. Keeping the wire dumb is what lets both
// credentials (project keys for ordinary clients, Ed25519 grants for the
// RealBud worker) share one serving core.
//
// Compatibility policy, so it cannot drift silently: each request field is
// HONORED (mapped), REFUSED with a named error, or accepted-and-inert (`user`).
// Nothing is silently dropped — a parameter the service cannot honour today is
// refused as `unsupported_parameter:<name>` rather than ignored, and the
// README's compatibility matrix is the public list.

import { GatewayError, integer, object, requireThat, type Units } from './contracts.ts';
import { validateMessages, type AssistantMessage, type ModelMessage, type ToolCall, type ToolDefinition } from './messages.ts';

/** Top-level fields the surface accepts; anything else is refused BY NAME. */
const CHAT_FIELDS = ['model', 'messages', 'stream', 'max_tokens', 'max_completion_tokens', 'tools', 'tool_choice', 'stream_options', 'user'] as const;

export interface ParsedChatRequest {
  /** The requested route id, or `auto`. Resolving it is the service's job. */
  model: string;
  stream: boolean;
  /** Absent means "the service decides", bounded by the provider's own ceiling. */
  maxOutputTokens?: number;
  messages: ModelMessage[];
  tools?: ToolDefinition[];
  /** True when the client asked usage to ride in the final SSE chunk. */
  includeUsage: boolean;
}

export function parseChatRequest(value: unknown): ParsedChatRequest {
  object(value);
  for (const key of Object.keys(value)) {
    requireThat((CHAT_FIELDS as readonly string[]).includes(key), `unsupported_parameter:${key}`);
  }

  const model = typeof value.model === 'string' ? value.model.trim() : '';
  requireThat(model.length > 0 && model.length <= 128, 'invalid_model');

  requireThat(Array.isArray(value.messages) && value.messages.length > 0 && value.messages.length <= 256, 'invalid_messages');
  const messages = (value.messages as unknown[]).map(convertMessage);

  if (value.stream !== undefined) requireThat(typeof value.stream === 'boolean', 'invalid_stream');
  const stream = value.stream === true;

  requireThat(!(value.max_tokens !== undefined && value.max_completion_tokens !== undefined), 'ambiguous_output_limit');
  const limit = value.max_tokens ?? value.max_completion_tokens;
  let maxOutputTokens: number | undefined;
  if (limit !== undefined) {
    integer(limit, 1_000_000);
    requireThat(limit > 0, 'invalid_output_limit');
    maxOutputTokens = limit;
  }

  let tools: ToolDefinition[] | undefined;
  if (value.tools !== undefined) {
    requireThat(Array.isArray(value.tools), 'invalid_tools');
    // Zero tools is the same as none; the shapes are validated below.
    tools = value.tools.length === 0 ? undefined : (value.tools as ToolDefinition[]);
  }
  requireThat(value.tool_choice === undefined || value.tool_choice === 'auto', 'unsupported_tool_choice');

  let includeUsage = false;
  if (value.stream_options !== undefined) {
    object(value.stream_options);
    for (const key of Object.keys(value.stream_options)) {
      requireThat(key === 'include_usage', `unsupported_parameter:stream_options.${key}`);
    }
    const flag = value.stream_options.include_usage;
    if (flag !== undefined) {
      requireThat(typeof flag === 'boolean', 'invalid_stream_options');
      includeUsage = flag;
    }
  }

  // Accepted and inert: it identifies the end user for abuse tracking and never
  // changes generation, so dropping it is not a silent behaviour change.
  requireThat(value.user === undefined || (typeof value.user === 'string' && value.user.length <= 256), 'invalid_user');

  const toolHistory = messages.some((m) => m.role === 'tool' || (m.role === 'assistant' && m.tool_calls !== undefined));
  requireThat(!toolHistory || tools !== undefined, 'tools_required_for_tool_history');

  // The SAME structural validators the signed-grant path uses, so both
  // credentials accept exactly the same conversation shapes. `thinking` is a
  // placeholder enum member — the service decides the real mode later, and
  // message consistency does not depend on which member it is.
  validateMessages(tools !== undefined
    ? { messages, protocol: 'tools-v1', tools, thinking: 'enabled' }
    : { messages });

  return {
    model,
    stream,
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    messages,
    ...(tools === undefined ? {} : { tools }),
    includeUsage,
  };
}

function convertMessage(raw: unknown): ModelMessage {
  object(raw);
  const role = raw.role;
  if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') {
    throw new GatewayError('unsupported_message_role');
  }

  if (role === 'system' || role === 'user') {
    for (const key of Object.keys(raw)) requireThat(key === 'role' || key === 'content', `unsupported_parameter:messages.${key}`);
    requireThat(typeof raw.content === 'string', Array.isArray(raw.content) ? 'unsupported_content_parts' : 'invalid_message_text');
    return { role, content: raw.content as string };
  }

  if (role === 'assistant') {
    for (const key of Object.keys(raw)) {
      requireThat(['role', 'content', 'tool_calls', 'reasoning_content'].includes(key), `unsupported_parameter:messages.${key}`);
    }
    requireThat(raw.content === null || typeof raw.content === 'string', Array.isArray(raw.content) ? 'unsupported_content_parts' : 'invalid_message_text');
    const message: AssistantMessage = { role: 'assistant', content: raw.content as string | null };
    if (raw.reasoning_content !== undefined) {
      requireThat(typeof raw.reasoning_content === 'string', 'invalid_message_text');
      message.reasoning_content = raw.reasoning_content as string;
    }
    if (raw.tool_calls !== undefined) {
      requireThat(Array.isArray(raw.tool_calls) && raw.tool_calls.length > 0 && raw.tool_calls.length <= 64, 'invalid_tool_calls');
      // validateMessages/validateAssistant check each call exactly (id, type,
      // function name, parseable arguments), so the raw shape passes through.
      message.tool_calls = raw.tool_calls as ToolCall[];
    }
    return message;
  }

  // role === 'tool'
  for (const key of Object.keys(raw)) requireThat(['role', 'content', 'tool_call_id'].includes(key), `unsupported_parameter:messages.${key}`);
  requireThat(typeof raw.content === 'string', 'invalid_message_text');
  const callId = raw.tool_call_id;
  requireThat(typeof callId === 'string' && callId.length > 0 && callId.length <= 160, 'invalid_tool_call_id');
  return { role: 'tool', content: raw.content as string, tool_call_id: callId as string };
}

// ---------------------------------------------------------------------------
// Response side. Pure builders — the service assembles outcomes and sends.
// ---------------------------------------------------------------------------

export interface CompletionMeta {
  /** e.g. `chatcmpl-<uuid>`; the caller generates it so replays are testable. */
  id: string;
  /** Unix seconds, as OpenAI clients expect. */
  created: number;
  /** The model actually served, not the alias that was requested. */
  model: string;
}

export interface CompletionOutcome {
  content: string | null;
  toolCalls?: readonly ToolCall[];
  finishReason: 'stop' | 'tool_calls';
  usage?: Units;
}

/** Pair the disjoint internal units with OpenAI's inclusive usage numbers. */
export function openAIUsage(units: Units) {
  const cached = units.cache_read_tokens ?? 0;
  const input = (units.input_tokens ?? 0) + cached;
  const output = units.output_tokens ?? 0;
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: input + output,
    ...(cached === 0 ? {} : { prompt_tokens_details: { cached_tokens: cached } }),
  };
}

export function completionBody(meta: CompletionMeta, outcome: CompletionOutcome) {
  return {
    id: meta.id,
    object: 'chat.completion',
    created: meta.created,
    model: meta.model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: outcome.content,
        ...(outcome.toolCalls === undefined || outcome.toolCalls.length === 0 ? {} : { tool_calls: outcome.toolCalls }),
      },
      finish_reason: outcome.finishReason,
    }],
    ...(outcome.usage === undefined ? {} : { usage: openAIUsage(outcome.usage) }),
  };
}

export function modelsBody(ids: readonly string[], created: number) {
  return {
    object: 'list',
    data: ids.map((id) => ({ id, object: 'model', created, owned_by: 'realbud-managed-ai' })),
  };
}

export type OpenAIErrorType = 'invalid_request_error' | 'authentication_error' | 'rate_limit_error' | 'insufficient_quota' | 'server_error';

export function openAIErrorBody(message: string, code: string, type: OpenAIErrorType = 'invalid_request_error') {
  return { error: { message, type, code, param: null } };
}

/**
 * Streams `chat.completion.chunk` frames. The service calls, in order:
 * `start()` → `content()` per delta → `finish()` → `usage()` → `done()`.
 * Tool calls arrive whole in one final delta — providers hand them over
 * completed, and fragments are never presented as executable calls.
 */
export class ChatCompletionStream {
  private readonly meta: CompletionMeta;
  private readonly includeUsage: boolean;
  // Written out rather than a constructor parameter property: Node's
  // --experimental-strip-types cannot erase parameter properties, and this
  // module runs directly under it (see the same note in contracts.ts).
  constructor(meta: CompletionMeta, includeUsage: boolean) {
    this.meta = meta;
    this.includeUsage = includeUsage;
  }

  private frame(payload: unknown): string { return `data: ${JSON.stringify(payload)}\n\n`; }

  private chunk(delta: unknown, finishReason: string | null): string {
    return this.frame({
      id: this.meta.id,
      object: 'chat.completion.chunk',
      created: this.meta.created,
      model: this.meta.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    });
  }

  start(): string { return this.chunk({ role: 'assistant', content: '' }, null); }

  content(text: string): string { return this.chunk({ content: text }, null); }

  finish(outcome: Pick<CompletionOutcome, 'toolCalls' | 'finishReason'>): string[] {
    const frames: string[] = [];
    if (outcome.toolCalls !== undefined && outcome.toolCalls.length > 0) {
      frames.push(this.chunk({
        tool_calls: outcome.toolCalls.map((call, index) => ({ index, id: call.id, type: call.type, function: call.function })),
      }, null));
    }
    frames.push(this.chunk({}, outcome.finishReason));
    return frames;
  }

  usage(units: Units): string[] {
    if (!this.includeUsage) return [];
    return [this.frame({
      id: this.meta.id,
      object: 'chat.completion.chunk',
      created: this.meta.created,
      model: this.meta.model,
      choices: [],
      usage: openAIUsage(units),
    })];
  }

  done(): string { return 'data: [DONE]\n\n'; }
}
