import { describe, expect, it } from 'vitest';
import {
  LINK_DISPLAY_CODE, isLinkRequestInput, isLinkRequestIssued, isLinkStatus, isLinkStatusInput, linkDisplayCode,
} from './installation-link.ts';

const origin = 'https://realbud.app';
const installationId = '0f8fad5b-d9cb-469f-a165-70867728950e';
const approvalId = 'A'.repeat(43);
const request = {
  version: 1, purpose: 'installation-link-request', id: installationId, token: 'a'.repeat(64),
  label: 'Reception Mac', platform: 'darwin', appVersion: '0.1.19',
};
const issued = { version: 1, purpose: 'installation-link-issued', approvalUrl: `${origin}/link/${approvalId}`, displayCode: 'ABCD-EFGH', expiresAt: '2026-09-23T10:00:00.000Z' };
const status = (fields: Record<string, unknown>) => ({ version: 1, purpose: 'installation-link-status', ...fields });

describe('link request sent by the desktop', () => {
  it('accepts the exact request and rejects added, missing or malformed fields', () => {
    expect(isLinkRequestInput(request)).toBe(true);
    expect(isLinkRequestInput({ ...request, extra: 1 })).toBe(false);
    const { label: _label, ...missing } = request;
    expect(isLinkRequestInput(missing)).toBe(false);
    for (const bad of [
      { id: installationId.toUpperCase() }, { token: 'A'.repeat(64) }, { token: 'a'.repeat(63) }, { label: '  ' }, { label: 'x'.repeat(81) },
      { label: 'Desk\nMac' }, { platform: 'android' }, { appVersion: '0.1.19;rm' }, { version: 2 }, { purpose: 'installation-link-status' },
    ]) expect(isLinkRequestInput({ ...request, ...bad })).toBe(false);
  });
});

describe('approval reply from the website', () => {
  it('accepts an approval page on the configured origin', () => {
    expect(isLinkRequestIssued(issued, origin)).toBe(true);
    // The loopback test fixture may use http, and only on its own origin.
    expect(isLinkRequestIssued({ ...issued, approvalUrl: `http://127.0.0.1:4100/link/${approvalId}` }, 'http://127.0.0.1:4100')).toBe(true);
  });

  it('rejects an approval URL on any other origin, scheme or path', () => {
    for (const approvalUrl of [
      `https://realbud.app.evil.test/link/${approvalId}`,
      `https://evil.test/link/${approvalId}`,
      `http://realbud.app/link/${approvalId}`,
      `https://user:pass@realbud.app/link/${approvalId}`,
      `${origin}/link/${approvalId}?next=https://evil.test`,
      `${origin}/link/${approvalId}#x`,
      `${origin}/account/link/${approvalId}`,
      `${origin}/link/${approvalId.slice(1)}`,
      `javascript:alert(1)`,
      `${origin}/link/${'A'.repeat(300)}`,
    ]) expect(isLinkRequestIssued({ ...issued, approvalUrl }, origin)).toBe(false);
    // A plain-http origin that is not loopback never passes, even when configured.
    expect(isLinkRequestIssued({ ...issued, approvalUrl: `http://staging.test/link/${approvalId}` }, 'http://staging.test')).toBe(false);
  });

  it('rejects a bad display code, expiry or an added field', () => {
    for (const displayCode of ['ABCD-EFG0', 'abcd-efgh', 'ABCDEFGH', 'ABCD-EFGI']) expect(isLinkRequestIssued({ ...issued, displayCode }, origin)).toBe(false);
    for (const expiresAt of ['2026-09-23T10:00:00Z', 'tomorrow', '2026-02-30T10:00:00.000Z']) expect(isLinkRequestIssued({ ...issued, expiresAt }, origin)).toBe(false);
    expect(isLinkRequestIssued({ ...issued, token: 'a'.repeat(64) }, origin)).toBe(false);
    expect(isLinkRequestIssued(null, origin)).toBe(false);
  });
});

describe('status poll and reply', () => {
  it('accepts the exact status request', () => {
    expect(isLinkStatusInput({ version: 1, purpose: 'installation-link-status', id: installationId })).toBe(true);
    expect(isLinkStatusInput({ version: 1, purpose: 'installation-link-status', id: installationId, token: 'a'.repeat(64) })).toBe(false);
    expect(isLinkStatusInput({ version: 1, purpose: 'installation-link-status', id: 'not-an-id' })).toBe(false);
  });

  it('accepts each state with exactly its own fields', () => {
    expect(isLinkStatus(status({ state: 'pending', expiresAt: issued.expiresAt }))).toBe(true);
    expect(isLinkStatus(status({ state: 'linked', companyId: 'office-a', agencyLabel: 'Synthetic Office', installationId }))).toBe(true);
    expect(isLinkStatus(status({ state: 'expired' }))).toBe(true);
    expect(isLinkStatus(status({ state: 'declined' }))).toBe(true);
  });

  it('rejects unknown states, extra fields and a linked reply without a valid installation', () => {
    expect(isLinkStatus(status({ state: 'approved' }))).toBe(false);
    expect(isLinkStatus(status({ state: 'expired', expiresAt: issued.expiresAt }))).toBe(false);
    expect(isLinkStatus(status({ state: 'pending' }))).toBe(false);
    const linked = { state: 'linked', companyId: 'office-a', agencyLabel: 'Synthetic Office', installationId };
    expect(isLinkStatus(status({ ...linked, provisioning: {} }))).toBe(false);
    expect(isLinkStatus(status({ ...linked, installationId: 'x' }))).toBe(false);
    expect(isLinkStatus(status({ ...linked, companyId: '' }))).toBe(false);
    expect(isLinkStatus(status({ ...linked, agencyLabel: 'x'.repeat(201) }))).toBe(false);
    expect(isLinkStatus({ ...status({ state: 'declined' }), version: 2 })).toBe(false);
    expect(isLinkStatus([])).toBe(false);
  });
});

describe('display code', () => {
  it('uses eight look-alike-free characters and needs eight random bytes', () => {
    const code = linkDisplayCode(Uint8Array.from([0, 1, 2, 3, 28, 29, 30, 31]));
    expect(code).toBe('ABCD-6789');
    expect(LINK_DISPLAY_CODE.test(code)).toBe(true);
    expect(LINK_DISPLAY_CODE.test(linkDisplayCode(Uint8Array.from([255, 254, 253, 252, 251, 250, 249, 248])))).toBe(true);
    expect(() => linkDisplayCode(new Uint8Array(7))).toThrow(/eight random bytes/);
  });
});
