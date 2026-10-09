import { describe, expect, it, vi } from 'vitest';
import type { DepartmentConfiguration, DepartmentConfigurationHistoryItem, SaveDepartmentConfigurationInput } from '@shared/department-configuration';
vi.mock('@/state/store', () => ({ api: vi.fn() }));
import { createCompanyApi, departmentMutationUncertain } from './company-api';

const id = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const departmentId = id(1), requestId = id(2), token = 'fictional_department_owner_session_123456';
const department = { id: departmentId, name: 'Fictional accounts', revision: '12', access: 'write' as const, retiredAt: null, retiredBy: null, retirementNote: '', unresolvedCases: 0 };
const configuration: DepartmentConfiguration = {
  version: 1, template: 'accounts-admin',
  plans: [{ recipe: { id: 'fictional-review', revision: 2, digest: 'a'.repeat(64), instructionDigest: 'b'.repeat(64), review: {
    plan: { title: 'Fictional review', description: 'Draft a supplied case summary.', steps: ['Read the supplied facts.'], evidence: 'A reviewable draft.', capabilities: ['analyse', 'draft'], allowedOrigins: [], limits: { maxRuntimeMinutes: 2, maxTurns: 6 }, siteNotes: null },
    instructions: 'Use only the supplied fictional case facts.',
  } }, pack: { id: 'fictional-accounts', revision: 1, bindingDigest: 'c'.repeat(64) } }],
  workflowDefaults: [{ id: 'case-review', label: 'Case review', defaultRecipeId: 'fictional-review' }],
};
const input: SaveDepartmentConfigurationInput = { requestId, departmentId, expectedRevision: '11', configuration, reviewDigest: 'd'.repeat(64), note: 'Reviewed fictional department workflow.', sourceReceiptId: null };
const read = () => ({ department: { ...department }, configuration: structuredClone(configuration), canManage: true });
const candidates = () => ({ ...read(), candidates: structuredClone(configuration.plans), unavailable: [{ id: '', reason: 'This instance needs setup before checking other plans.' }], omitted: 2 });
const saved = () => ({ department: { ...department }, configuration: structuredClone(configuration), receiptId: requestId, replayed: false });
const entry = (revision = 12): DepartmentConfigurationHistoryItem => ({ receiptId: id(revision + 10), revision: String(revision), previousRevision: String(revision - 1), savedAt: '2026-10-03T00:00:00.000Z', savedBy: { id: id(3), displayName: 'Fictional owner' }, note: 'Reviewed supplied plan.', sourceReceiptId: null, configuration: structuredClone(configuration) });
const history = () => ({ department: { ...department }, entries: [entry()], nextBeforeRevision: null as string | null });
const storage = () => ({ getItem: () => token, setItem: vi.fn(), removeItem: vi.fn() });
const ackPath = '/api/company/department-outbox/ack';

describe('department configuration reads', () => {
  it('reads the requested department through the member session without acknowledging or changing it', async () => {
    const response = read(), request = vi.fn().mockResolvedValue(response);
    await expect(createCompanyApi(request, storage()).departmentConfiguration(departmentId)).resolves.toEqual(response);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe('/api/company/departments/configuration');
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({ departmentId });
    expect(new Headers(request.mock.calls[0][1].headers).get('x-realbud-member-session')).toBe(token);
    expect(request.mock.calls[0][0]).not.toContain(token);
  });

  it('preserves an explicitly unconfigured, read-only department', async () => {
    const response = { ...read(), configuration: null, canManage: false };
    await expect(createCompanyApi(vi.fn().mockResolvedValue(response)).departmentConfiguration(departmentId)).resolves.toEqual(response);
  });

  it.each([
    ['foreign department', () => ({ ...read(), department: { ...department, id: id(99) } })],
    ['oversized revision', () => ({ ...read(), department: { ...department, revision: '9223372036854775808' } })],
    ['coerced authority', () => ({ ...read(), canManage: 'true' })],
    ['unknown response field', () => ({ ...read(), memberToken: token })],
    ['missing configuration', () => ({ department, canManage: true })],
    ['extra plan authority', () => ({ ...read(), configuration: { ...configuration, approvals: 'automatic' } })],
    ['unselected default', () => ({ ...read(), configuration: { ...configuration, workflowDefaults: [{ id: 'case-review', label: 'Case review', defaultRecipeId: 'not-selected' }] } })],
  ] as const)('rejects %s before returning configuration to the view', async (_name, response) => {
    const request = vi.fn().mockResolvedValue(response());
    await expect(createCompanyApi(request).departmentConfiguration(departmentId)).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('returns complete candidate reviews, omitted count and department-level readiness without inventing a recipe id', async () => {
    const response = candidates(), request = vi.fn().mockResolvedValue(response);
    await expect(createCompanyApi(request).departmentConfigurationCandidates(departmentId)).resolves.toEqual(response);
    expect(request.mock.calls[0][0]).toBe('/api/company/department-work/configuration-candidates');
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({ departmentId });
  });

  it.each([
    ['duplicate candidate', () => ({ ...candidates(), candidates: [...configuration.plans, ...configuration.plans] })],
    ['missing reviewed instructions', () => ({ ...candidates(), candidates: [{ ...configuration.plans[0], recipe: { ...configuration.plans[0].recipe, review: undefined } }] })],
    ['malformed pack binding', () => ({ ...candidates(), candidates: [{ ...configuration.plans[0], pack: { id: 'fictional-accounts', revision: 1, bindingDigest: 'short' } }] })],
    ['negative omitted count', () => ({ ...candidates(), omitted: -1 })],
    ['fractional omitted count', () => ({ ...candidates(), omitted: 1.5 })],
    ['duplicate unavailable state', () => ({ ...candidates(), unavailable: [{ id: '', reason: 'First' }, { id: '', reason: 'Second' }] })],
    ['unknown unavailable field', () => ({ ...candidates(), unavailable: [{ id: '', reason: 'Held', skipApproval: true }] })],
  ] as const)('rejects %s in candidate discovery', async (_name, response) => {
    await expect(createCompanyApi(vi.fn().mockResolvedValue(response())).departmentConfigurationCandidates(departmentId)).rejects.toThrow();
  });
});

describe('department configuration history', () => {
  it('reads bounded descending history and preserves exact restoration provenance', async () => {
    const response = { ...history(), entries: Array.from({ length: 10 }, (_, i) => ({ ...entry(12 - i), sourceReceiptId: i === 0 ? id(99) : null })), nextBeforeRevision: '3' };
    const request = vi.fn().mockResolvedValue(response);
    await expect(createCompanyApi(request).departmentConfigurationHistory(departmentId, '13')).resolves.toEqual(response);
    expect(request.mock.calls[0][0]).toBe('/api/company/departments/configuration/history');
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({ departmentId, beforeRevision: '13', limit: 10 });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['foreign department', () => ({ ...history(), department: { ...department, id: id(99) } })],
    ['duplicate receipt', () => ({ ...history(), entries: [entry(12), { ...entry(11), receiptId: entry(12).receiptId }] })],
    ['ascending revisions', () => ({ ...history(), entries: [entry(11), entry(12)] })],
    ['incorrect predecessor', () => ({ ...history(), entries: [{ ...entry(), previousRevision: '10' }] })],
    ['unknown entry field', () => ({ ...history(), entries: [{ ...entry(), executionToken: token }] })],
    ['malformed restore receipt', () => ({ ...history(), entries: [{ ...entry(), sourceReceiptId: 'not-a-receipt' }] })],
    ['invalid saved date', () => ({ ...history(), entries: [{ ...entry(), savedAt: 'not-a-date' }] })],
    ['invalid saved configuration', () => ({ ...history(), entries: [{ ...entry(), configuration: { ...configuration, version: 2 } }] })],
    ['cursor on an incomplete page', () => ({ ...history(), nextBeforeRevision: '12' })],
    ['cursor unlike the final entry', () => ({ ...history(), entries: Array.from({ length: 10 }, (_, i) => entry(12 - i)), nextBeforeRevision: '2' })],
  ] as const)('rejects %s in history', async (_name, response) => {
    await expect(createCompanyApi(vi.fn().mockResolvedValue(response())).departmentConfigurationHistory(departmentId)).rejects.toThrow();
  });

  it('rejects entries newer than the returned department even when a caller supplies a larger cursor', async () => {
    await expect(createCompanyApi(vi.fn().mockResolvedValue({ ...history(), entries: [entry(19)] })).departmentConfigurationHistory(departmentId, '20')).rejects.toThrow();
  });

  it('validates the department revision even on a later history page', async () => {
    await expect(createCompanyApi(vi.fn().mockResolvedValue({ ...history(), department: { ...department, revision: '9223372036854775808' } })).departmentConfigurationHistory(departmentId, '20')).rejects.toThrow();
  });
});

describe('department configuration save receipt boundary', () => {
  it.each([400,401,403,404,405,409,422])('marks only a first initial HTTP refusal %s as definitely not recorded', async status => {
    const request = vi.fn().mockRejectedValue({ status }); const error = await createCompanyApi(request).saveDepartmentConfiguration(input).catch(cause => cause);
    expect(error.departmentConfigurationFirstRefusal).toBe(true); expect(request).toHaveBeenCalledTimes(1);
  });
  it.each([410,408,429,500,503,undefined])('keeps initial uncertain HTTP/transport outcome %s unclassified', async status => {
    const request = vi.fn().mockRejectedValue({ status, departmentConfigurationFirstRefusal: true }); const error = await createCompanyApi(request).saveDepartmentConfiguration(input).catch(cause => cause);
    expect(error.departmentConfigurationFirstRefusal).toBeUndefined();
  });
  it.each([403,409,422])('does not turn ACK refusal %s into first-request no-effect evidence', async status => {
    const request = vi.fn().mockResolvedValueOnce(saved()).mockRejectedValueOnce({ status }); const error = await createCompanyApi(request).saveDepartmentConfiguration(input).catch(cause => cause);
    expect(error.departmentConfigurationFirstRefusal).toBeUndefined(); expect(request.mock.calls.map(call => call[0])).toEqual(['/api/company/departments/configuration/save',ackPath]);
  });
  it.each([403,409])('keeps exact replay refusal %s uncertain, regardless of prior queue acknowledgement', async status => {
    const request = vi.fn().mockRejectedValue({ status }); const error = await createCompanyApi(request).resumeDepartmentOperation({ path:'/api/company/departments/configuration/save',input }).catch(cause => cause);
    expect(error.departmentConfigurationFirstRefusal).toBeUndefined(); expect(JSON.parse(request.mock.calls[0][1].body)).toEqual(input);
  });
  it('does not mark a malformed success as a definitive first refusal', async () => {
    const error = await createCompanyApi(vi.fn().mockResolvedValue({ ...saved(), receiptId:id(99) })).saveDepartmentConfiguration(input).catch(cause=>cause);
    expect(error.departmentConfigurationFirstRefusal).toBeUndefined();
  });
  it.each([false, true])('acknowledges only the exact validated request (replayed=%s)', async replayed => {
    const response = { ...saved(), replayed }, request = vi.fn().mockResolvedValueOnce(response).mockResolvedValueOnce({ ok: true });
    const client = createCompanyApi(request, storage()), changed = vi.fn(); client.subscribeDepartmentChanges(changed);
    await expect(client.saveDepartmentConfiguration(input)).resolves.toEqual(response);
    expect(request.mock.calls.map(call => call[0])).toEqual(['/api/company/departments/configuration/save', ackPath]);
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual(input);
    expect(JSON.parse(request.mock.calls[1][1].body)).toEqual({ requestId });
    expect(new Headers(request.mock.calls[1][1].headers).get('x-realbud-member-session')).toBe(token);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['different receipt', () => ({ ...saved(), receiptId: id(99) })],
    ['different department', () => ({ ...saved(), department: { ...department, id: id(99) } })],
    ['different configuration', () => ({ ...saved(), configuration: { ...configuration, template: 'custom' } })],
    ['changed reviewed instructions', () => ({ ...saved(), configuration: { ...configuration, plans: [{ ...configuration.plans[0], recipe: { ...configuration.plans[0].recipe, review: { ...configuration.plans[0].recipe.review, instructions: 'A different plan.' } } }] } })],
    ['unchanged revision', () => ({ ...saved(), department: { ...department, revision: '11' } })],
    ['skipped revision', () => ({ ...saved(), department: { ...department, revision: '13' } })],
    ['coerced replay flag', () => ({ ...saved(), replayed: 'false' })],
    ['unknown receipt field', () => ({ ...saved(), providerKey: 'fictional-secret' })],
  ] as const)('keeps the saved request unacknowledged for %s', async (_name, response) => {
    const request = vi.fn().mockResolvedValue(response());
    await expect(createCompanyApi(request).saveDepartmentConfiguration(input)).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).not.toBe(ackPath);
  });

  it('treats a lost acknowledgement as uncertain without automatically repeating a committed save', async () => {
    const request = vi.fn().mockResolvedValueOnce(saved()).mockRejectedValueOnce(new Error('Fictional lost acknowledgement'));
    const error = await createCompanyApi(request).saveDepartmentConfiguration(input).catch(error => error);
    expect(error).toBeInstanceOf(Error); expect(departmentMutationUncertain(error)).toBe(true);
    expect(request.mock.calls.map(call => call[0])).toEqual(['/api/company/departments/configuration/save', ackPath]);
  });

  it('rejects malformed acknowledgement without claiming journal completion', async () => {
    const request = vi.fn().mockResolvedValueOnce(saved()).mockResolvedValueOnce({ ok: false });
    await expect(createCompanyApi(request).saveDepartmentConfiguration(input)).rejects.toThrow('incomplete response');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('rejects extra authority in a save before sending it to the service', async () => {
    const request = vi.fn();
    await expect(createCompanyApi(request).saveDepartmentConfiguration({ ...input, bypassReview: true } as SaveDepartmentConfigurationInput)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it('resumes exactly the saved configuration and source receipt instead of creating a new operation', async () => {
    const restore = { ...input, sourceReceiptId: id(99), note: 'Restore the reviewed earlier configuration.' };
    const response = { ...saved(), replayed: true }, request = vi.fn().mockResolvedValueOnce(response).mockResolvedValueOnce({ ok: true });
    await createCompanyApi(request).resumeDepartmentOperation({ path: '/api/company/departments/configuration/save', input: restore });
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual(restore);
    expect(JSON.parse(request.mock.calls[1][1].body)).toEqual({ requestId });
  });
});

describe('configuration session fencing', () => {
  it.each(['read', 'candidates', 'history', 'save'] as const)('rejects a late %s response after sign-out and never acknowledges it', async operation => {
    let reply!: (value: unknown) => void;
    const request = vi.fn().mockImplementationOnce(() => new Promise(resolve => { reply = resolve; })).mockResolvedValueOnce({ ok: true });
    const client = createCompanyApi(request, storage());
    const pending = operation === 'read' ? client.departmentConfiguration(departmentId) : operation === 'candidates' ? client.departmentConfigurationCandidates(departmentId) : operation === 'history' ? client.departmentConfigurationHistory(departmentId) : client.saveDepartmentConfiguration(input);
    const rejected = expect(pending).rejects.toThrow();
    await client.logout(); reply(operation === 'read' ? read() : operation === 'candidates' ? candidates() : operation === 'history' ? history() : saved());
    await rejected;
    expect(request.mock.calls.some(call => call[0] === ackPath)).toBe(false);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
