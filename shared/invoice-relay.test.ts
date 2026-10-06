import { describe, expect, it } from 'vitest';
import { relayNotice } from './invoice-relay.ts';

describe('relayNotice', () => {
  it('asks staff to check bank details on Xero-relayed invoices', () => {
    expect(relayNotice('Fictional Plumbing <messaging-service@post.xero.com>', 'ben@fictional-plumbing.example'))
      .toBe("Sent via Xero for ben@fictional-plumbing.example. Xero doesn't verify this address — check the bank details match REI before paying.");
  });
  it('says nothing for direct senders or lookalike domains', () => {
    expect(relayNotice('accounts@fictional-plumbing.example')).toBeNull();
    expect(relayNotice('x@post.xero.com.evil.example')).toBeNull();
  });
});
