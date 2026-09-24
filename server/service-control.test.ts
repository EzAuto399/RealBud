import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { serviceControl } from './service-control.ts';

const token = 'c'.repeat(64);
const instanceId = 'fictional-installation';
const pid = 4242;
const id = createHash('sha256').update(token).digest('hex');
const body = { pid, instanceId, controlId: id };
const request = (headers: IncomingMessage['headers'] = {}) => ({ headers: { 'x-realbud-service-control': token, ...headers } });

describe('service shutdown capability', () => {
  it('publishes only the digest and accepts the capability for this process', () => {
    const control = serviceControl(token, instanceId, pid);
    expect(control.id).toBe(id);
    expect(control.id).not.toBe(token);
    expect(control.accepts(request(), body)).toBe(true);
  });

  it('does not enable control for a missing or malformed process secret', () => {
    for (const value of [undefined, '', 'c'.repeat(63), 'g'.repeat(64)]) {
      const control = serviceControl(value, instanceId, pid);
      expect(control.id).toBeNull();
      expect(control.accepts(request(), body)).toBe(false);
    }
  });

  it('rejects absent, mismatched and repeated capability headers', () => {
    const control = serviceControl(token, instanceId, pid);
    for (const value of [undefined, 'd'.repeat(64), id, [token, token]]) {
      expect(control.accepts(request({ 'x-realbud-service-control': value }), body)).toBe(false);
    }
  });

  it('rejects browser origins even with the correct capability', () => {
    const control = serviceControl(token, instanceId, pid);
    for (const origin of ['http://127.0.0.1:8799', 'https://fictional.example', 'null']) {
      expect(control.accepts(request({ origin }), body)).toBe(false);
    }
  });

  it('rejects malformed bodies and stale process or installation identities', () => {
    const control = serviceControl(token, instanceId, pid);
    for (const value of [undefined, null, [], 'stop', {}, { ...body, pid: pid + 1 }, { ...body, pid: String(pid) }, { ...body, instanceId: 'different-installation' }, { ...body, controlId: 'd'.repeat(64) }]) {
      expect(control.accepts(request(), value)).toBe(false);
    }
  });
});
