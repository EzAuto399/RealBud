import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './testing.ts';
import { directProvider } from './direct-provider.ts';
import { verifyGrant } from './auth.ts';
import type { ModelRequest } from './contracts.ts';

for (const effort of ['low', 'high', 'max', undefined] as const) {
  test(`DeepSeek sends signed thinking mode and explicit ${effort ?? 'omitted'} reasoning effort without changing tools or output bounds`, async () => {
    const f = fixture();
    try {
      let sent: Record<string, unknown> | undefined;
      const request: ModelRequest = {
        ...f.request, protocol: 'tools-v1', thinking: effort ? 'enabled' : 'disabled',
        tools: [{ type: 'function', function: { name: 'read_record', parameters: { type: 'object' } } }],
        ...(effort ? { reasoningEffort: effort } : {}),
      };
      const provider = directProvider({
        provider: 'deepseek', model: request.model, upstreamModel: 'deepseek-flash',
        enforcedContextTokens: 100, maximumOutputTokens: 20, terms: f.provider.terms,
        secret: async () => 'synthetic-key',
        fetch: (async (url, init) => {
          assert.equal(String(url), 'https://api.deepseek.com/chat/completions');
          sent = JSON.parse(String(init?.body));
          const common = { id: 'effort-fixture', model: 'deepseek-flash' };
          const chunks = [
            { ...common, choices: [{ index: 0, delta: { role: 'assistant', content: 'Synthetic reply', ...(effort ? { reasoning_content: 'SYNTHETIC_REASONING' } : {}) }, finish_reason: 'stop' }] },
            { ...common, choices: [], usage: { prompt_tokens: 15, completion_tokens: 4, total_tokens: 19, prompt_cache_hit_tokens: 5, prompt_cache_miss_tokens: 10 } },
          ];
          return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
        }) as typeof fetch,
      });
      const grant = f.grant(request, {
        schema: 2, grantVersion: 2, modelCallId: 'effort-call',
        maxAttemptSpendNanoAud: '1000000000', attemptExpiresAt: f.now() + 120000,
        provider: 'deepseek', allowedModels: [{ provider: 'deepseek', model: request.model, capabilities: ['text', 'tools'] }],
      });
      if (effort) assert.throws(() => verifyGrant(f.envelope(grant), { ...request, reasoningEffort: effort === 'low' ? 'high' : 'low' }, f.ledger), /request_scope_mismatch/);
      await f.run(f.gateway(provider), request, grant);
      assert(sent);
      assert.deepEqual(sent.thinking, { type: request.thinking });
      assert.equal(sent.reasoning_effort, effort);
      assert.equal(Object.hasOwn(sent, 'reasoning_effort'), effort !== undefined);
      assert.equal(sent.max_tokens, 20);
      assert.deepEqual(sent.tools, request.tools);
      assert.equal(f.ledger.requests('company-a')[0].chargedNanoAud, '19250000');
    } finally { f.close(); }
  });
}

test('DeepSeek rejects unsupported effort values or effort with thinking disabled before transport', () => {
  const f = fixture();
  try {
    let calls = 0;
    const provider = directProvider({ provider: 'deepseek', model: f.request.model, upstreamModel: 'deepseek-flash', enforcedContextTokens: 100, maximumOutputTokens: 20, terms: f.provider.terms, secret: async () => 'fixture', fetch: (async () => { calls++; throw Error('must not call'); }) as typeof fetch });
    const request: ModelRequest = { ...f.request, protocol: 'tools-v1', tools: [], thinking: 'enabled' };
    assert.throws(() => provider.bound({ ...request, reasoningEffort: 'ultra' } as never), /invalid_thinking_mode/);
    assert.throws(() => provider.bound({ ...request, thinking: 'disabled', reasoningEffort: 'max' }), /effort_requires_thinking/);
    assert.equal(calls, 0);
  } finally { f.close(); }
});
