import { describe, expect, it } from 'vitest';
import { ConnectionAuthorizationError, connectionCheckReply, connectionFailureReply, managedAuthorizationFailure } from './connection-outcome.ts';

describe('truthful connection failure guidance', () => {
  it.each([
    [403, 'connector_app_not_admitted'], [404, 'connector_app_unavailable'], [404, 'connector_toolkit_unknown'],
    [400, 'connector_auth_config_rejected'], [502, 'connector_link_rejected'], [403, 'office_mailbox_owner_authorization_required'],
  ])('describes a definitive gateway refusal before sign-in for %s %s', (status, code) => {
    const error = managedAuthorizationFailure(Number(status), String(code));
    expect(error.outcome).toBe('not-started');
    const reply = connectionFailureReply('Google Sheets', error, true);
    expect(reply).toContain('Sign-in for Google Sheets did not start.');
    expect(reply).not.toMatch(/Finish any|already open|https?:/);
    expect(reply).toContain('After setup is resolved');
  });
  it('tells a shared-only office how to allow personal Gmail too', () => {
    expect(connectionFailureReply('Gmail', managedAuthorizationFailure(403, 'office_mailbox_owner_authorization_required'), true)).toContain('sets Gmail to Both');
  });
  it.each([[403, undefined], [404, undefined], [404, 'private_diagnostic'], [409, 'connector_link_outcome_unknown'], [409, 'connector_account_already_bound'], [502, 'request_failed'], [429, 'connector_link_rejected'], [502, 'connector_app_not_admitted']])('keeps uncertain effects held for %s %s', (status, code) => {
    const error = managedAuthorizationFailure(Number(status), code as string | undefined);
    expect(error.outcome).toBe('unknown');
    const reply = connectionFailureReply('Sheets', error, true);
    expect(reply).toContain("couldn't confirm whether Sheets sign-in was created");
    expect(reply).toContain("don't start another sign-in yet");
    expect(reply).not.toMatch(/did not start|No new sign-in|Finish any|already open/);
  });
  it('never exposes arbitrary transport errors or trusts a forged marker as proof of refusal', () => {
    const forged = Object.assign(new Error('private token https://evil.invalid/link'), { outcome: 'not-started', reason: 'unavailable' });
    expect(connectionFailureReply('Sheets', forged, true)).not.toMatch(/private token|evil|did not start/);
    expect(connectionFailureReply('Sheets', forged, false)).toContain('No new sign-in was started');
    expect(connectionFailureReply('Sheets', new ConnectionAuthorizationError('not-started', 'setup'), true)).toContain('service setup');
  });
  it('mentions a pending sign-in only when observed account status supports it', () => {
    const none = { connected: false, status: 'NOT_CONNECTED', accounts: [], accountSelectionRequired: false };
    expect(connectionCheckReply('Sheets', none)).toContain('This check did not start sign-in');
    expect(connectionCheckReply('Sheets')).not.toContain('pending');
    expect(connectionCheckReply('Sheets', { ...none, status: 'INITIATED' })).toContain('has a pending sign-in');
    expect(connectionCheckReply('Sheets', { ...none, accounts: [{ id: 'a', status: 'PENDING' }] })).toContain('before starting another');
  });
});
