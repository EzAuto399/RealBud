import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonical } from './contracts.ts';
import { OpenAICostsPoller } from './openai-costs.ts';

const FIXTURE_TIME = Date.parse('2026-09-16T04:00:00Z');

test('OpenAI costs polling stays disabled without transport, coalesces, never becomes a client invoice', async () => {
  let time = FIXTURE_TIME,
    secrets = 0,
    calls = 0,
    fail = false;
  const disabled = new OpenAICostsPoller({
    secret: async () => {
      secrets++;
      return 'secret';
    },
  });
  assert.equal((await disabled.poll()).configured, false);
  assert.equal(secrets, 0);
  assert.equal(disabled.status().clientInvoice, 'unsupported');
  assert.equal(disabled.status().perClientHistory, 'unsupported_unconfigured');

  const poller = new OpenAICostsPoller({
    now: () => time,
    secret: async () => {
      secrets++;
      return 'sk-admin-fixture';
    },
    fetch: (async (url, init) => {
      calls++;
      const href = String(url);
      assert.match(href, /^https:\/\/api\.openai\.com\/v1\/organization\/costs\?/);
      assert.match(href, /group_by=api_key_id/);
      assert.equal(init?.method, 'GET');
      if (fail) return new Response('PRIVATE UPSTREAM ERROR', { status: 500 });
      return Response.json({
        object: 'page',
        data: [
          {
            object: 'bucket',
            start_time: 1757894400,
            end_time: 1757980800,
            results: [
              {
                object: 'organization.costs.result',
                amount: { value: 0.06, currency: 'usd' },
                api_key_id: 'key_abc123xyz',
              },
            ],
          },
        ],
        has_more: false,
        next_page: null,
      });
    }) as typeof fetch,
  });
  const [first, parallel] = await Promise.all([poller.poll(), poller.poll()]);
  assert.equal(calls, 1);
  assert.deepEqual(first, parallel);
  assert.equal(first.lastUpdatedAt, time);
  assert.equal(first.stale, false);
  assert.equal(first.snapshot!.currency, 'USD');
  assert.equal(first.snapshot!.buckets[0]!.byApiKeyId.key_abc123xyz, '0.06000000');
  assert.equal(first.clientInvoice, 'unsupported');
  await poller.poll();
  assert.equal(calls, 1);
  time += 120000;
  assert.equal(poller.status().stale, true);
  fail = true;
  const failed = await poller.poll();
  assert.equal(failed.error, 'costs_sync_failed');
  assert.equal(failed.snapshot!.buckets[0]!.totalUsd.startsWith('0.06'), true);
  assert(!canonical(failed).includes('PRIVATE'));
  assert(!canonical(failed).includes('sk-admin'));
  assert.equal(failed.nextAttemptAt, time + 60000);
  for (let n = 0; n < 8; n++) {
    time = poller.status().nextAttemptAt;
    await poller.poll();
  }
  assert.equal(poller.status().nextAttemptAt - time, 600000);
  fail = false;
  time = poller.status().nextAttemptAt;
  assert.equal((await poller.poll()).stale, false);
  assert.equal(poller.status().consecutiveFailures, 0);
});
