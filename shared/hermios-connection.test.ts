import { describe, expect, it } from 'vitest';
import { HERMIOS_CONNECTION_REASONS, parseHermiosConnectionStart, parseHermiosConnectionState } from './hermios-connection.ts';

const account = { displayName: 'Fictional Member', workspaceLabel: 'Fictional Realty', workspaceId: '0a0a0a0a-0000-4000-8000-00000000a11c', profileId: 'fictional-1', verifiedAt: 1_700_000_000_000 };

describe('Hermios connection contract', () => {
  it('accepts the server state shapes', () => {
    expect(parseHermiosConnectionState({ version: 1, status: 'not_connected', account: null, generation: 0, reason: null })).not.toBeNull();
    expect(parseHermiosConnectionState({ version: 1, status: 'connected', account, generation: 1, reason: null })?.account).toEqual(account);
    expect(parseHermiosConnectionState({ version: 1, status: 'needs_reconnect', account, generation: 1, reason: HERMIOS_CONNECTION_REASONS.accountChanged })).not.toBeNull();
    expect(parseHermiosConnectionState({ version: 1, status: 'unavailable', account: null, generation: 2, reason: HERMIOS_CONNECTION_REASONS.unreachable })).not.toBeNull();
  });

  it('rejects inconsistent or extended state', () => {
    expect(parseHermiosConnectionState({ version: 1, status: 'connected', account: null, generation: 1, reason: null })).toBeNull();
    expect(parseHermiosConnectionState({ version: 1, status: 'not_connected', account, generation: 1, reason: null })).toBeNull();
    expect(parseHermiosConnectionState({ version: 1, status: 'connected', account, generation: 1, reason: null, accessToken: 'x' })).toBeNull();
    expect(parseHermiosConnectionState({ version: 1, status: 'connected', account: { ...account, token: 'x' }, generation: 1, reason: null })).toBeNull();
    expect(parseHermiosConnectionState({ version: 1, status: 'connected', account, generation: -1, reason: null })).toBeNull();
  });

  it('keeps every fixed reason within the contract limit', () => {
    for (const reason of Object.values(HERMIOS_CONNECTION_REASONS)) {
      expect(parseHermiosConnectionState({ version: 1, status: 'unavailable', account: null, generation: 0, reason })).not.toBeNull();
    }
  });

  it('accepts only https hermios.app authorize links', () => {
    expect(parseHermiosConnectionStart({ authorizeUrl: 'https://app.hermios.app/authorize?state=s' })).not.toBeNull();
    expect(parseHermiosConnectionStart({ authorizeUrl: 'http://app.hermios.app/authorize' })).toBeNull();
    expect(parseHermiosConnectionStart({ authorizeUrl: 'https://hermios.app.example.test/authorize' })).toBeNull();
    expect(parseHermiosConnectionStart({ authorizeUrl: 'https://app.hermios.app/authorize', extra: 1 })).toBeNull();
  });
});
