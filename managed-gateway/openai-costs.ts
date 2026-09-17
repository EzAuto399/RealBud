/** Operator-only OpenAI organisation spend. Never a per-client invoice authority. */
import { exact, integer, object, requireThat } from './contracts.ts';
import { abortable } from './abort.ts';

export interface OpenAICostBucket {
  startTime: number;
  endTime: number;
  totalUsd: string;
  /** Opaque OpenAI key ids (`key_…`), never the secret. Empty when the org did not group by key. */
  byApiKeyId: Record<string, string>;
}
export interface OpenAICostsSnapshot {
  startTime: number;
  endTime: number;
  currency: 'USD';
  buckets: OpenAICostBucket[];
  updatedAt: number;
}

function money(value: unknown): string {
  requireThat(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 1e12, 'invalid_cost_amount');
  return value.toFixed(8);
}

export class OpenAICostsPoller {
  private readonly transport: typeof fetch | undefined;
  private readonly secret: () => Promise<string>;
  private readonly now: () => number;
  private snapshot: OpenAICostsSnapshot | undefined;
  private inFlight: Promise<ReturnType<OpenAICostsPoller['status']>> | undefined;
  private failures = 0;
  private dueAt = 0;
  private error: string | undefined;
  constructor(options: { fetch?: typeof fetch; secret: () => Promise<string>; now?: () => number }) {
    this.transport = options.fetch;
    this.secret = options.secret;
    this.now = options.now ?? Date.now;
  }
  status() {
    return {
      configured: !!this.transport,
      lastUpdatedAt: this.snapshot?.updatedAt ?? null,
      stale: !this.snapshot || this.now() - this.snapshot.updatedAt >= 120_000,
      error: this.error ?? null,
      nextAttemptAt: this.dueAt,
      consecutiveFailures: this.failures,
      snapshot: this.snapshot ? structuredClone(this.snapshot) : null,
      perClientHistory: 'unsupported_unconfigured' as const,
      clientInvoice: 'unsupported' as const,
    };
  }
  /** Owning service clock only. One flight, min 60s, max 10m error backoff. No timer on construct. */
  poll() {
    if (!this.transport || this.now() < this.dueAt) return Promise.resolve(this.status());
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.read().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }
  private async read() {
    const signal = AbortSignal.timeout(8000);
    try {
      const key = await abortable(this.secret(), signal);
      requireThat(key.length > 0, 'costs_secret_unavailable');
      const end = Math.floor(this.now() / 1000);
      const start = end - 7 * 86400;
      integer(start, Number.MAX_SAFE_INTEGER);
      integer(end, Number.MAX_SAFE_INTEGER);
      const url = `https://api.openai.com/v1/organization/costs?start_time=${start}&bucket_width=1d&limit=7&group_by=api_key_id`;
      const response = await abortable(
        this.transport!(url, {
          method: 'GET',
          redirect: 'error',
          signal,
          headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        }),
        signal,
      );
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        requireThat(false, 'costs_request_failed');
      }
      requireThat(response.body, 'invalid_costs_response');
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const part = await abortable(reader.read(), signal);
          if (part.done) break;
          bytes += part.value.byteLength;
          requireThat(bytes <= 256_000, 'costs_response_too_large');
          chunks.push(part.value);
        }
      } finally {
        void reader.cancel().catch(() => {});
      }
      let value: unknown;
      try {
        value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        requireThat(false, 'invalid_costs_response');
      }
      object(value);
      requireThat(value.object === 'page' && Array.isArray(value.data) && value.data.length <= 180, 'invalid_costs_response');
      const buckets: OpenAICostBucket[] = [];
      for (const item of value.data) {
        object(item);
        requireThat(item.object === 'bucket', 'invalid_costs_bucket');
        integer(item.start_time, Number.MAX_SAFE_INTEGER);
        integer(item.end_time, Number.MAX_SAFE_INTEGER);
        requireThat(item.end_time > item.start_time && Array.isArray(item.results) && item.results.length <= 200, 'invalid_costs_bucket');
        const byApiKeyId: Record<string, string> = {};
        let total = 0;
        for (const row of item.results) {
          object(row);
          requireThat(row.object === 'organization.costs.result', 'invalid_costs_result');
          object(row.amount);
          exact(row.amount, ['value', 'currency']);
          requireThat(row.amount.currency === 'usd', 'invalid_cost_currency');
          const amount = Number(money(row.amount.value));
          total += amount;
          if (typeof row.api_key_id === 'string' && /^key_[A-Za-z0-9]{6,80}$/.test(row.api_key_id)) {
            byApiKeyId[row.api_key_id] = money(row.amount.value);
          }
        }
        buckets.push({
          startTime: item.start_time,
          endTime: item.end_time,
          totalUsd: money(total),
          byApiKeyId,
        });
      }
      const updatedAt = this.now();
      integer(updatedAt, Number.MAX_SAFE_INTEGER);
      this.snapshot = {
        startTime: start,
        endTime: end,
        currency: 'USD',
        buckets,
        updatedAt,
      };
      this.failures = 0;
      this.error = undefined;
      this.dueAt = updatedAt + 60_000;
    } catch {
      this.failures = Math.min(this.failures + 1, 10);
      this.error = 'costs_sync_failed';
      this.dueAt = this.now() + Math.min(600_000, 60_000 * 2 ** (this.failures - 1));
    }
    return this.status();
  }
}
