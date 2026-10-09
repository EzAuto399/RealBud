import { describe, expect, it, vi } from 'vitest';
import { createCompanyHost } from './company-host.ts';

// Mixed versions on one LAN office: the host checks the expected office a
// current member names, and keeps an older member (which names none) working.
const companyId = '11111111-1111-4111-8111-111111111111';
const otherCompanyId = '22222222-2222-4222-8222-222222222222';
const session = 'a'.repeat(43);
function fixture() {
  const kernel = {
    getBootstrapState: vi.fn(async () => ({ companies: [{ companyId, name: 'Example Office' }] })),
    authenticateSession: vi.fn(async () => ({ companyId, memberId: 'fixture-member', displayName: 'Example Person', role: 'member' })),
    redeemInvitation: vi.fn(async (_token: string, _credential: unknown, _expected?: string) => ({ sessionToken: session, recoveryKey: 'fictional-recovery-key' })),
    signInMember: vi.fn(async (_input: { expectedCompanyId?: string }) => ({ sessionToken: session })),
    recoverMember: vi.fn(async (_input: { expectedCompanyId?: string }) => ({ sessionToken: session, recoveryKey: 'fictional-recovery-key' })),
  };
  const host = createCompanyHost({ kernel: kernel as never, authorizeAdmin: () => ({ ok: false, status: 401, error: 'Service administration required' }) as never, hasAdminSession: () => false });
  return { kernel, host };
}
const join = { invitationToken: 'fictional-invitation', credential: { loginName: 'fixture', password: 'Synthetic-password-2026' } };
const signIn = { loginName: 'fixture', password: 'Synthetic-password-2026' };
const recover = { loginName: 'fixture', recoveryKey: 'fictional-recovery-key', newPassword: 'Synthetic-new-password-2026' };

describe('host office precondition across member versions', () => {
  it('admits an older member that names no office, checked against this host’s own office', async () => {
    const { kernel, host } = fixture();
    expect((await host.handle('/api/company/join', 'POST', { headers: {} }, join)).status).toBe(201);
    expect((await host.handle('/api/company/sign-in', 'POST', { headers: {} }, signIn)).status).toBe(200);
    expect((await host.handle('/api/company/recover-member', 'POST', { headers: {} }, recover)).status).toBe(200);
    expect(kernel.redeemInvitation.mock.calls[0][2]).toBe(companyId);
    expect(kernel.signInMember.mock.calls[0][0].expectedCompanyId).toBe(companyId);
    expect(kernel.recoverMember.mock.calls[0][0].expectedCompanyId).toBe(companyId);
  });
  it('passes a current member’s expected office to the kernel check', async () => {
    const { kernel, host } = fixture();
    const headers = { 'x-realbud-company-id': otherCompanyId };
    await host.handle('/api/company/join', 'POST', { headers }, join);
    await host.handle('/api/company/sign-in', 'POST', { headers }, signIn);
    await host.handle('/api/company/recover-member', 'POST', { headers }, recover);
    expect(kernel.redeemInvitation.mock.calls[0][2]).toBe(otherCompanyId);
    expect(kernel.signInMember.mock.calls[0][0].expectedCompanyId).toBe(otherCompanyId);
    expect(kernel.recoverMember.mock.calls[0][0].expectedCompanyId).toBe(otherCompanyId);
  });
  it('refuses a malformed expected office before any credential work', async () => {
    const { kernel, host } = fixture();
    expect(await host.handle('/api/company/sign-in', 'POST', { headers: { 'x-realbud-company-id': 'not-an-office' } }, signIn)).toMatchObject({ status: 400, body: { code: 'invalid_input' } });
    expect(kernel.signInMember).not.toHaveBeenCalled();
  });
  it('names its office on status for current members', async () => {
    const { host } = fixture();
    expect(await host.handle('/api/company/status', 'GET', { headers: {} })).toMatchObject({ status: 200, body: { configured: true, hostCompany: { version: 1, companyId } } });
  });
});
