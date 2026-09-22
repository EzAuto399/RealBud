import { describe, expect, it, vi } from "vitest";
vi.mock("@/state/store", () => ({ api: vi.fn() }));
import { createCompanyApi } from "./company-api";

const initialCredential = { loginName: "fixture.user", password: "Synthetic-fixture-password-2026" };
const ownerToken = "synthetic_owner_session_1234567890";
const memberToken = "synthetic_member_session_1234567890";
const session = (token = ownerToken, role = "owner") => ({ memberToken: token, company: { id: "company-fixture", name: "Example Office" }, member: { id: `person-${role}`, displayName: "Example Person", role } });
const status = { storageAvailable: true, configured: true, setupAllowed: false, transport: "local-only", limitations: [] };
function memoryStorage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}

describe("company member session transport", () => {
  it.each([
    ["host_identity_mismatch", "different office"],
    ["seat_identity_conflict", "another member"],
  ])("explains %s without suggesting a username change or exposing backend details", async (code, message) => {
    const storage = memoryStorage();
    const request = vi.fn().mockRejectedValue({ status: 409, code, message: "private backend detail" });
    const client = createCompanyApi(request, storage);
    await expect(client.join("fixture_invitation", initialCredential)).rejects.toMatchObject({ message: expect.stringContaining(message), memberSessionEnded: false });
    expect(storage.values.size).toBe(0);
  });

  it("retains the same member after a host outage without replaying an uncertain write", async () => {
    const storage = memoryStorage();
    let available = true;
    const request = vi.fn(async (path: string) => {
      if (path.endsWith("/sign-in")) return session();
      if (!available) throw { status: 503 };
      return { ...status, transport: "encrypted-company", company: session().company, member: session().member };
    });
    const client = createCompanyApi(request, storage);
    await client.signIn(initialCredential);
    const version = client.sessionVersion();
    available = false;
    await expect(client.invite("Bob")).rejects.toMatchObject({ status: 503, memberSessionEnded: false });
    await expect(client.status()).rejects.toMatchObject({ status: 503, memberSessionEnded: false });
    expect(client.sessionVersion()).toBe(version);
    expect([...storage.values.values()]).toEqual([ownerToken]);
    available = true;
    expect(await client.status()).toMatchObject({ member: session().member });
    expect(request.mock.calls.filter(([path]) => path.endsWith("/invitations"))).toHaveLength(1);
    expect(client.sessionVersion()).toBe(version);
  });

  it("does not strand an active member after a wrong password when changing credentials", async () => {
    const storage = memoryStorage();
    const request = vi.fn().mockResolvedValueOnce(session()).mockRejectedValueOnce({ status: 401 }).mockResolvedValueOnce({ ...status, company: session().company, member: session().member });
    const client = createCompanyApi(request, storage);
    await client.signIn({ loginName: "alice", password: "Synthetic-password-2026" });
    await expect(client.credentials({ loginName: "alice", password: "New-synthetic-password", currentPassword: "wrong" })).rejects.toMatchObject({ message: expect.stringContaining("not accepted"), memberSessionEnded: false });
    expect([...storage.values.values()]).toEqual([ownerToken]);
    await client.status();
    expect(new Headers(request.mock.calls[2][1].headers).get("x-realbud-member-session")).toBe(ownerToken);
  });

  it("retains company identity when enabling joining needs service administrator sign-in", async () => {
    const storage = memoryStorage();
    const request = vi.fn().mockResolvedValueOnce(session()).mockRejectedValueOnce({ status: 401 }).mockResolvedValueOnce({ ...status, company: session().company, member: session().member });
    const client = createCompanyApi(request, storage);
    await client.signIn({ loginName: "alice", password: "Synthetic-password-2026" });
    await expect(client.enableJoining("office-host.local")).rejects.toMatchObject({ message: expect.stringContaining("Service administrator sign-in"), memberSessionEnded: false });
    expect([...storage.values.values()]).toEqual([ownerToken]);
    await client.status();
    expect(new Headers(request.mock.calls[2][1].headers).get("x-realbud-member-session")).toBe(ownerToken);
  });

  it("returns a recovery key only to the current operation and does not persist it", async () => {
    const storage = memoryStorage();
    const recoveryKey = "synthetic_recovery_key_1234567890123456";
    const request = vi.fn().mockResolvedValueOnce({ ...session(), recoveryKey });
    const client = createCompanyApi(request, storage);
    expect((await client.recover({ loginName: "alice", recoveryKey: "previous", newPassword: "New-synthetic-password" })).recoveryKey).toBe(recoveryKey);
    expect([...storage.values.values()]).toEqual([ownerToken]);
    expect(request.mock.calls[0][0]).not.toContain("previous");
  });

  it("uses the member header, restores only tab storage, and never puts the token in a URL", async () => {
    const storage = memoryStorage();
    const request = vi.fn().mockResolvedValueOnce(session()).mockResolvedValueOnce({ ...status, company: session().company, member: session().member });
    const client = createCompanyApi(request, storage);
    await client.create({ name: "Example Office", ownerName: "Example Person", credential: initialCredential });
    const reopened = createCompanyApi(request, storage);
    await reopened.status();
    const [path, init] = request.mock.calls[1];
    expect(path).toBe("/api/company/status");
    expect(new Headers(init.headers).get("x-realbud-member-session")).toBe(ownerToken);
    expect(path).not.toContain(ownerToken);
    expect(storage.values.size).toBe(1);
  });

  it("keeps a usable memory session when browser storage is blocked", async () => {
    const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
    const request = vi.fn().mockResolvedValueOnce(session()).mockResolvedValueOnce(status);
    const client = createCompanyApi(request, blocked);
    await client.create({ name: "Example Office", ownerName: "Example Person", credential: initialCredential });
    await client.status();
    expect(new Headers(request.mock.calls[1][1].headers).get("x-realbud-member-session")).toBe(ownerToken);
  });

  it("clears expired membership and hides backend details", async () => {
    const storage = memoryStorage();
    const request = vi.fn().mockResolvedValueOnce(session()).mockRejectedValueOnce(Object.assign(new Error(`secret ${ownerToken}`), { status: 401 })).mockResolvedValueOnce(status);
    const client = createCompanyApi(request, storage);
    await client.create({ name: "Example Office", ownerName: "Example Person", credential: initialCredential });
    await expect(client.invite("Another Person")).rejects.toMatchObject({ message: expect.stringContaining("session has ended"), memberSessionEnded: true });
    expect(storage.values.size).toBe(0);
    await client.status();
    expect(new Headers(request.mock.calls[2][1].headers).has("x-realbud-member-session")).toBe(false);
  });

  it("does not accept a pending sign-in after sign out", async () => {
    let complete!: (value: unknown) => void;
    const storage = memoryStorage();
    const request = vi.fn().mockImplementationOnce(() => new Promise(resolve => { complete = resolve; })).mockResolvedValueOnce({});
    const client = createCompanyApi(request, storage);
    const joining = client.join("synthetic_invitation_token_1234567890", initialCredential);
    const rejected = expect(joining).rejects.toThrow("Joining could not be confirmed");
    await client.logout();
    complete(session(memberToken, "member"));
    await rejected;
    expect(storage.values.size).toBe(0);
  });

  it("a late older sign-in cannot replace a newer member", async () => {
    let complete!: (value: unknown) => void;
    const storage = memoryStorage();
    const request = vi.fn().mockImplementationOnce(() => new Promise(resolve => { complete = resolve; })).mockResolvedValueOnce(session(memberToken, "member"));
    const client = createCompanyApi(request, storage);
    const old = client.join("synthetic_old_invitation_1234567890", initialCredential);
    const rejected = expect(old).rejects.toThrow();
    await client.join("synthetic_new_invitation_1234567890", initialCredential);
    complete(session());
    await rejected;
    expect([...storage.values.values()]).toEqual([memberToken]);
  });

  it("retains a failed logout session to allow revocation retry, then removes it on success", async () => {
    const storage = memoryStorage();
    const request = vi.fn().mockResolvedValueOnce(session()).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({});
    const client = createCompanyApi(request, storage);
    await client.create({ name: "Example Office", ownerName: "Example Person", credential: initialCredential });
    await expect(client.logout()).rejects.toThrow("Sign out could not be confirmed");
    expect([...storage.values.values()]).toEqual([ownerToken]);
    await client.logout();
    expect(storage.values.size).toBe(0);
    expect(new Headers(request.mock.calls[2][1].headers).get("x-realbud-member-session")).toBe(ownerToken);
  });

  it("rejects malformed membership and does not save its token", async () => {
    const storage = memoryStorage();
    const client = createCompanyApi(vi.fn().mockResolvedValue(session(ownerToken, "superuser")), storage);
    await expect(client.create({ name: "Example Office", ownerName: "Example Person", credential: initialCredential })).rejects.toThrow("incomplete response");
    expect(storage.values.size).toBe(0);
  });

  it("fails closed for unknown transport and malformed invitation expiry", async () => {
    const client = createCompanyApi(vi.fn().mockResolvedValueOnce({ ...status, transport: "public-http" }).mockResolvedValueOnce({ invitationToken: ownerToken, expiresAt: "unknown" }));
    await expect(client.status()).rejects.toThrow("incomplete response");
    await expect(client.invite("Example Person")).rejects.toThrow("incomplete response");
  });

  it("keeps invitation failures useful without reflecting input or provider errors", async () => {
    const request = vi.fn().mockRejectedValue(Object.assign(new Error(`invalid private invitation ${ownerToken}`), { status: 410 }));
    const client = createCompanyApi(request);
    await expect(client.join(ownerToken, initialCredential)).rejects.toThrow("invalid, expired or already used");
    await expect(client.join(ownerToken, initialCredential)).rejects.not.toThrow(ownerToken);
  });

  it("distinguishes an invalid join from an expired company or administrator session", async () => {
    const client = createCompanyApi(vi.fn().mockRejectedValue(Object.assign(new Error("unauthenticated"), { status: 401 })));
    await expect(client.join(ownerToken, initialCredential)).rejects.toThrow("invitation is invalid, expired or already used");
    await expect(client.create({ name: "Fixture", ownerName: "Fixture", credential: initialCredential })).rejects.toThrow("Service administrator sign-in is required");
  });

  it("preserves a held owner recovery without storing an administrator-created identity", async () => {
    const request = vi.fn().mockRejectedValue(Object.assign(new Error("owner proof required"), { status: 409 }));
    const storage = memoryStorage();
    const client = createCompanyApi(request, storage);
    await expect(client.recoverOwner()).rejects.toThrow("independent identity verification");
    expect(request.mock.calls[0][0]).toBe("/api/company/recover-owner");
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({});
    expect(storage.values.size).toBe(0);
  });

  it("drops a stored session when the service no longer recognizes a member", async () => {
    const storage = memoryStorage();
    const request = vi.fn().mockResolvedValueOnce(session()).mockResolvedValueOnce(status).mockResolvedValueOnce(status);
    const client = createCompanyApi(request, storage);
    await client.create({ name: "Example Office", ownerName: "Example Person", credential: initialCredential });
    await client.status();
    expect(storage.values.size).toBe(0);
    await client.status();
    expect(new Headers(request.mock.calls[2][1].headers).has("x-realbud-member-session")).toBe(false);
  });
});


it("waits for bounded first storage initialization while ordinary checks stay short", async () => {
  const request = vi.fn().mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce(status);
  const client = createCompanyApi(request);
  await client.setup(); await client.status();
  expect(request.mock.calls[0][2].timeoutMs).toBe(120_000);
  expect(request.mock.calls[1][2].timeoutMs).toBe(15_000);
});

it("distinguishes a damaged host code from an unavailable host without exposing transport details", async () => {
  const request = vi.fn().mockRejectedValueOnce(Object.assign(new Error("private transport details"), { status: 400 }))
    .mockRejectedValueOnce(Object.assign(new Error("private transport details"), { status: 503 }));
  const client = createCompanyApi(request);
  await expect(client.connectHost("bad code")).rejects.toThrow("Copy the whole current code");
  await expect(client.connectHost("valid but offline")).rejects.toThrow("Keep RealBud open on the host computer");
});

describe('lifecycle client authority and restart contracts', () => {
  it('keeps membership when a host backup requires service administration', async () => {
    const storage = memoryStorage();
    const request = vi.fn().mockResolvedValueOnce(session()).mockRejectedValueOnce(Object.assign(new Error('Admin needed'), { status: 401, code: 'service_admin_required' }));
    const client = createCompanyApi(request, storage); await client.signIn(initialCredential);
    await expect(client.hostRecovery('backup', { passphrase: 'Synthetic passphrase', retireSource: false })).rejects.toMatchObject({ memberSessionEnded: false, code: 'service_admin_required' });
    expect([...storage.values.values()]).toEqual([ownerToken]);
    expect(request.mock.calls[1][2]).toMatchObject({ timeoutMs: 120_000 });
  });
  it('holds an uncertain departure session, and clears it only after success', async () => {
    const storage = memoryStorage();
    const request = vi.fn().mockResolvedValueOnce(session()).mockRejectedValueOnce({ status: 503 }).mockResolvedValueOnce({ ok: true });
    const client = createCompanyApi(request, storage); await client.signIn(initialCredential);
    await expect(client.leaveOffice()).rejects.toThrow(); expect([...storage.values.values()]).toEqual([ownerToken]);
    await client.leaveOffice(); expect(storage.values.size).toBe(0);
    expect(request.mock.calls.filter(([path]) => path === '/api/company/leave-office')).toHaveLength(2);
  });
  it('preserves complete saved share audiences and rejects malformed recovery responses', async () => {
    const saved = { requestId: '11111111-1111-4111-8111-111111111111', title: 'Synthetic review', summary: 'Draft', purpose: 'request-review', recipientMemberIds: ['one', 'two'], assigneeMemberId: 'two', evidence: null };
    const request = vi.fn().mockResolvedValueOnce({ pending: { phase: 'pending', input: saved }, otherOfficePending: false }).mockResolvedValueOnce({ pending: { phase: 'pending', input: { ...saved, assigneeMemberId: {} } }, otherOfficePending: false });
    const client = createCompanyApi(request);
    expect((await client.pendingShare()).pending?.input).toEqual(saved);
    await expect(client.pendingShare()).rejects.toThrow(/incomplete/);
  });
  it('marks host replacement and offline detach explicitly and never carries a token into the next office', async () => {
    const storage = memoryStorage(); const request = vi.fn().mockResolvedValueOnce(session()).mockResolvedValue({ ok: true });
    const client = createCompanyApi(request, storage); await client.signIn(initialCredential);
    await client.connectHost('synthetic-code', true);
    expect(JSON.parse(request.mock.calls[1][1].body)).toEqual({ hostCode: 'synthetic-code', replaceExisting: true });
    expect(storage.values.size).toBe(0);
    await client.detachOffline();
    expect(JSON.parse(request.mock.calls[2][1].body)).toEqual({ acknowledgeActiveSessions: true });
  });
});
