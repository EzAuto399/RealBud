import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, it, expect, vi } from 'vitest';
import { WorkflowDatabase } from './workflow-database.ts';
import { createWebsiteRemoteWork, validateSavedWebsiteRemoteWork, restoreWebsiteRemoteWork, WEBSITE_REMOTE_WORK_KIND, type SavedWebsiteRemoteWork } from './website-remote-work.ts';
import { canonicalWebsiteCommand, type WebsiteCommandDescriptor } from '../shared/website-commands.ts';
import { REMOTE_DISCLOSURE_POLICY, type RemoteCommandGrant, type RemoteApproverGrant } from '../shared/website-remote-approvers.ts';
import type { RemoteWorkState, RemoteWorkReview, RemoteWorkClaimResult } from '../shared/website-remote-work.ts';
import type { WebsiteRequestRun } from './website-requests.ts';
import { removeFixture } from './testing/private-fixture.ts';
const hash = (v: unknown) => createHash('sha256').update(canonicalWebsiteCommand(v)).digest('hex');
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });
function fixture(operation: 'morning-review' | 'prepare-recipe' = 'morning-review') {
  const directory = mkdtempSync(join(tmpdir(), 'rb-remote-work-')), db = new WorkflowDatabase({ dir: directory, key: Buffer.alloc(32, 9) });
  let time = Date.parse('2026-09-22T06:00:00.000Z'), valid = true, sourceReady = true;
  const identity = { workspaceId: randomUUID(), workerProfileKey: 'worker-a' };
  const descriptor: WebsiteCommandDescriptor = { id: randomUUID(), operation, revision: 'a'.repeat(64), label: 'Work preparation' };
  const template = { version: 1 as const, policy: REMOTE_DISCLOSURE_POLICY, descriptor, mailboxAlias: operation === 'morning-review' ? 'Office mailbox' : null, sections: [{ label: 'Approved plan', value: 'Prepare the work for local review.' }] };
  const scope = { descriptorId: descriptor.id, descriptorRevision: descriptor.revision, disclosureDigest: hash(template) };
  const parent: RemoteCommandGrant = { protocol: 2, grantId: randomUUID(), generation: 1, installationId: randomUUID(), workspaceId: identity.workspaceId, workspaceLabel: 'Test workspace', workerBinding: randomUUID(), descriptors: [descriptor], companyId: 'agency', enrolledAt: new Date(time).toISOString(), revokedAt: null };
  const person = { subject: randomUUID(), identityEpoch: 1, email: 'person@agency.test', agencyLabel: 'Test Agency', companyId: 'agency' };
  const approver: RemoteApproverGrant = { protocol: 2, id: randomUUID(), generation: 1, parentGrantId: parent.grantId, parentGeneration: 1, installationId: parent.installationId, workspaceId: parent.workspaceId, workerBinding: parent.workerBinding, companyId: parent.companyId, person, scopes: [scope], disclosurePolicy: REMOTE_DISCLOSURE_POLICY, enrolledAt: new Date(time).toISOString(), expiresAt: new Date(time + 86400000).toISOString(), revokedAt: null };
  let mutate: ((route: string, result: any) => void) | null = null;
  let state: RemoteWorkState | undefined, review: RemoteWorkReview | null = null, sequence = 0, fail = '', failBefore = '', pause = '', released: (() => void) | null = null;
  const receipts = new Map<string, unknown>(), calls: {
    route: string;
    body: any;
  }[] = [];
  const runs = new Map<string, WebsiteRequestRun>();
  const fetcher = vi.fn(async (url: any, init: any) => {
    const route = String(url).split('/api/installations/')[1]!, body = JSON.parse(init.body);
    calls.push({ route, body });
    if (failBefore === route) { failBefore = ''; throw Error('Network unavailable before commit'); }
    let result: unknown;
    if (route === 'v2/work/poll')
      result = { grant: parent, requests: state && state.sequence > body.cursor ? [state] : [], cursor: sequence, hasMore: false, serverTime: new Date(time).toISOString() };
    else if (route === 'v2/work/review') {
      const key = body.review.reviewId;
      if (!receipts.has(key)) {
        if (body.expectedRevision !== state!.revision)
          return Response.json({}, { status: 409 });
        review = body.review;
        state = { ...state!, revision: state!.revision + 1, phase: 'delivered', sequence: ++sequence, review: { id: review!.reviewId, digest: body.reviewDigest, revision: 1, expiresAt: review!.expiresAt, decision: null, prunedAt: null } };
        receipts.set(key, { request: structuredClone(state), review, serverTime: new Date(time).toISOString() });
      }
      result = receipts.get(key);
    }
    else if (route === 'v2/work/claim') {
      if (!receipts.has(body.claimId)) {
        if (body.expectedRevision !== state!.revision)
          return Response.json({}, { status: 409 });
        state = { ...state!, phase: 'accepted', revision: state!.revision + 1, sequence: ++sequence };
        const receipt: RemoteWorkClaimResult = { request: structuredClone(state), claimId: body.claimId, reviewId: body.reviewId, reviewDigest: body.reviewDigest, decisionId: body.decisionId, previewDigest: body.previewDigest, activationId: body.activationId, serverTime: new Date(time).toISOString(), validUntil: new Date(time + 60000).toISOString() };
        receipts.set(body.claimId, receipt);
      }
      result = receipts.get(body.claimId);
    }
    else if (route === 'v2/work/ack' || route === 'v2/work/cancel') {
      const key = body.eventId ?? body.cancelId;
      if (!receipts.has(key)) {
        if (body.expectedRevision !== state!.revision)
          return Response.json({}, { status: 409 });
        state = { ...state!, revision: state!.revision + 1, sequence: ++sequence, ...(route.endsWith('/cancel') ? { cancellationRequested: true, phase: ['accepted', 'running'].includes(state!.phase) ? state!.phase : 'cancelled' as const, outcome: ['accepted', 'running'].includes(state!.phase) ? state!.outcome : 'cancelled' as const } : { phase: body.phase, outcome: body.outcome, runReference: body.runReference }) };
        receipts.set(key, structuredClone(state));
      }
      result = receipts.get(key);
    }
    else
      throw Error('Unexpected route');
    if (mutate) {
      result = structuredClone(result);
      mutate(route, result);
    }
    if (pause === route) {
      pause = '';
      await new Promise<void>(resolve => {
        released = resolve;
      });
    }
    if (fail === route) {
      fail = '';
      throw Error('Lost response');
    }
    return Response.json(result);
  }) as typeof fetch;
  const refreshRemoteSources = vi.fn(async () => {
    sourceReady = true;
  }), preview = vi.fn(async () => ({ title: 'Private preview', details: [{ label: 'Private account', value: 'customer-private-mail-id' }], binding: { privateKey: 'private-bound-source' } }));
  const check = vi.fn(async () => {
    if (!valid || !sourceReady)
      throw Error('Changed binding');
  });
  const dispatch = vi.fn(async (e: any) => {
    expect(service.executionBinding(e.requestId)?.binding).toEqual({ privateKey: 'private-bound-source' });
    const run: WebsiteRequestRun = { id: `run:${e.requestId}`, phase: 'running', outcome: null };
    runs.set(e.requestId, run);
    return run;
  });
  const options = {
    directory, db, identity: () => identity, officeLink: { credentials: async () => ({ installationId: parent.installationId, companyId: parent.companyId, token: 'f'.repeat(64), agencyLabel: 'Agency' }) }, authority: async () => {
      if (!valid || !sourceReady)
        throw Error('Unavailable');
      return {
        parent, commandToken: 'b'.repeat(64), identity, authority: 'c'.repeat(64), scopes: [scope], approvers: [approver], assertCurrent: async () => {
          if (!valid || !sourceReady)
            throw Error('Changed');
        }, isCurrent: () => valid && sourceReady
      };
    }, remoteTemplate: async () => template, refreshRemoteSources, preview, check, dispatch, lookup: async (e: any) => runs.get(e.requestId) ?? null, cancel: vi.fn(async (run: WebsiteRequestRun) => {
      for (const [id, r] of runs)
        if (r.id === run.id)
          runs.set(id, { ...r, phase: 'cancelled', outcome: 'cancelled' });
    }), exclusive: async <T>(work: () => Promise<T>) => work(), fetch: fetcher, now: () => time
  };
  let service = createWebsiteRemoteWork(options);
  cleanup.push(() => {
    service.stop();
    db.close();
    return removeFixture(directory);
  });
  function request() {
    const id = randomUUID();
    state = { envelope: { protocol: 2, id, companyId: parent.companyId, installationId: parent.installationId, workspaceId: parent.workspaceId, workerBinding: parent.workerBinding, grantId: parent.grantId, generation: 1, descriptor, requester: person, requesterEnrollmentId: approver.id, createdAt: new Date(time).toISOString(), expiresAt: new Date(time + 3600000).toISOString() }, revision: 1, phase: 'queued', cancellationRequested: false, runReference: null, outcome: null, updatedAt: new Date(time).toISOString(), sequence: ++sequence, review: null };
    return id;
  }
  function decide() {
    state = { ...state!, revision: state!.revision + 1, sequence: ++sequence, review: { ...state!.review!, revision: 2, decision: { protocol: 2, requestId: state!.envelope.id, reviewId: review!.reviewId, reviewDigest: hash(review), decisionId: randomUUID(), choice: 'approve', reviewRevision: 2, person, enrollmentId: approver.id, decidedAt: new Date(time).toISOString() } } };
  }
  const saved = () => db.page<SavedWebsiteRemoteWork>(WEBSITE_REMOTE_WORK_KIND, { limit: 1 }).records[0]!;
  return {
    options, directory, db, parent, approver, template, refreshRemoteSources, preview, dispatch, calls, request, decide, saved, runs, get service() {
      return service;
    }, restart() {
      service.stop();
      service = createWebsiteRemoteWork(options);
      sourceReady = false;
    }, mutate(fn: typeof mutate) {
      mutate = fn;
    }, fail(route: string) {
      fail = route;
    }, failBefore(route: string) { failBefore = route; }, pause(route: string) {
      pause = route;
    }, get paused() {
      return !!released;
    }, release() {
      released?.();
      released = null;
    }, change() {
      valid = false;
    }, advance(ms: number) {
      time += ms;
    }, get state() {
      return state!;
    }, setState(s: RemoteWorkState) {
      state = s;
      sequence = s.sequence;
    }
  };
}
it('default off performs no connection checks, preview, network or dispatch', async () => {
  const f = fixture();
  await f.service.sync();
  expect((await f.service.status()).enabled).toBe(false);
  expect(f.calls).toEqual([]);
  expect(f.refreshRemoteSources).not.toHaveBeenCalled();
  expect(f.preview).not.toHaveBeenCalled();
});
it.each(['morning-review', 'prepare-recipe'] as const)('publishes only approved disclosure and executes %s through existing guarded executor', async (operation) => {
  const f = fixture(operation);
  await f.service.enable();
  const id = f.request();
  await f.service.sync();
  expect(f.preview).toHaveBeenCalledOnce();
  expect(f.dispatch).not.toHaveBeenCalled();
  const upload = f.calls.find(c => c.route.endsWith('/review'))!;
  expect(upload.body.review.template).toEqual(f.template);
  expect(JSON.stringify(f.calls)).not.toContain('customer-private-mail-id');
  expect(JSON.stringify(f.calls)).not.toContain('private-bound-source');
  f.decide();
  await f.service.sync();
  expect(f.dispatch).toHaveBeenCalledOnce();
  expect(f.service.executionBinding(id)?.requestId).toBe(id);
  f.restart();
  await f.service.sync();
  expect(f.refreshRemoteSources).toHaveBeenCalled();
  expect(f.dispatch).toHaveBeenCalledOnce();
  expect(f.service.list().records[0]!.phase).toBe('running');
  expect(JSON.stringify(f.service.list())).not.toContain('private-bound-source');
});
it('persists exact review before upload and retries original lost response after restart', async () => {
  const f = fixture();
  await f.service.enable();
  f.request();
  f.fail('v2/work/review');
  await expect(f.service.sync()).rejects.toThrow();
  const publication = f.saved().value.publication;
  expect(f.saved().value.publicationPending).toBe(true);
  f.restart();
  await f.service.sync();
  expect(f.calls.filter(c => c.route.endsWith('/review')).map(c => c.body)).toEqual([publication, publication]);
  expect(f.preview).toHaveBeenCalledOnce();
});
it('ambiguous claim after restart never dispatches a new worker', async () => {
  const f = fixture();
  await f.service.enable();
  f.request();
  await f.service.sync();
  f.decide();
  f.fail('v2/work/claim');
  await expect(f.service.sync()).rejects.toThrow();
  expect(f.saved().value.intent?.stage).toBe('claim');
  f.restart();
  await f.service.sync();
  expect(f.dispatch).not.toHaveBeenCalled();
  expect(f.saved().value.cancellationRequested).toBe(true);
  expect(f.state.phase).toBe('interrupted');
  expect(f.state.outcome).toBe('execution-interrupted');
  expect(f.state.runReference).toBeNull();
  expect(f.calls.filter(c => c.route.endsWith('/claim'))).toHaveLength(1);
  expect(f.calls.filter(c => c.route.endsWith('/ack')).some(c => c.body.phase === 'running')).toBe(false);
});
it('changed worker at claim await prevents dispatch and leaves recoverable evidence', async () => {
  const f = fixture();
  await f.service.enable();
  f.request();
  await f.service.sync();
  f.decide();
  f.pause('v2/work/claim');
  const pending = f.service.sync();
  await vi.waitFor(() => expect(f.paused).toBe(true), { timeout: 30_000 });
  f.change();
  f.release();
  await expect(pending).rejects.toThrow();
  expect(f.dispatch).not.toHaveBeenCalled();
  expect(f.saved().value.phase).toBe('interrupted');
});
it('local disable while publication waits prevents subsequent execution and never revives old activation', async () => {
  const f = fixture();
  await f.service.enable();
  const old = (await f.service.status()).activationId;
  f.request();
  f.pause('v2/work/review');
  const pending = f.service.sync();
  await vi.waitFor(() => expect(f.paused).toBe(true), { timeout: 30_000 });
  f.service.invalidate();
  f.release();
  await expect(pending).rejects.toThrow();
  await f.service.disable();
  await f.service.enable();
  expect((await f.service.status()).activationId).not.toBe(old);
  await f.service.sync();
  expect(f.dispatch).not.toHaveBeenCalled();
  expect(f.saved().value.cancellationRequested).toBe(true);
});
it('metadata refresh failure holds enabled work without preview or network', async () => {
  const f = fixture();
  await f.service.enable();
  f.refreshRemoteSources.mockRejectedValueOnce(Error('Disconnected'));
  f.request();
  await expect(f.service.sync()).rejects.toThrow();
  expect(f.preview).not.toHaveBeenCalled();
  expect(f.calls).toEqual([]);
});
it('restored records retain evidence but clear publication, claim and cancellation authority', async () => {
  const f = fixture();
  await f.service.enable();
  f.request();
  await f.service.sync();
  const row = f.saved();
  const restored = restoreWebsiteRemoteWork(row.id, row.value, new Date().toISOString());
  expect(restored.restored).toBe(true);
  expect(restored.phase).toBe('interrupted');
  expect(restored.publication).toEqual(row.value.publication);
  expect(restored.publicationPending).toBe(false);
  expect(restored.intent).toBeNull();
  expect(restored.pendingCancel).toBeNull();
  expect(validateSavedWebsiteRemoteWork(row.id, restored)).toEqual(restored);
  for (const bad of [{ ...restored, version: 1 }, { ...restored, publicationPending: true }, { ...restored, extra: true }, { ...restored, activationId: randomUUID() }])
    expect(() => validateSavedWebsiteRemoteWork(row.id, bad)).toThrow();
});
it('rejects a substituted review receipt without clearing the saved exact outbox', async () => {
  const f = fixture();
  await f.service.enable();
  f.request();
  f.mutate((route, result) => {
    if (route.endsWith('/review'))
      result.review.template.sections[0].value = 'Different plan';
  });
  await expect(f.service.sync()).rejects.toThrow();
  expect(f.saved().value.publicationPending).toBe(true);
  expect(f.dispatch).not.toHaveBeenCalled();
});
it.each(['claimId', 'activationId', 'previewDigest'] as const)('rejects substituted %s in online claim receipt', async (field) => {
  const f = fixture();
  await f.service.enable();
  f.request();
  await f.service.sync();
  f.decide();
  f.mutate((route, result) => {
    if (route.endsWith('/claim'))
      result[field] = field === 'previewDigest' ? 'e'.repeat(64) : randomUUID();
  });
  await expect(f.service.sync()).rejects.toThrow();
  expect(f.dispatch).not.toHaveBeenCalled();
});
it('expired claim during a slow network wait is never dispatched', async () => {
  const f = fixture();
  await f.service.enable();
  f.request();
  await f.service.sync();
  f.decide();
  f.pause('v2/work/claim');
  const pending = f.service.sync();
  await vi.waitFor(() => expect(f.paused).toBe(true), { timeout: 30_000 });
  f.advance(60001);
  f.release();
  await expect(pending).rejects.toThrow(/expired/);
  expect(f.dispatch).not.toHaveBeenCalled();
  expect(f.saved().value.intent).toBeNull();
});
it('lost running acknowledgement reuses the event and never dispatches twice', async () => {
  const f = fixture();
  await f.service.enable();
  f.request();
  await f.service.sync();
  f.decide();
  f.fail('v2/work/ack');
  await expect(f.service.sync()).rejects.toThrow();
  const pending = f.saved().value.pendingEvent;
  expect(pending?.phase).toBe('running');
  await f.service.sync();
  expect(f.calls.filter(c => c.route.endsWith('/ack')).slice(-2).map(c => c.body)).toEqual([pending, pending]);
  expect(f.dispatch).toHaveBeenCalledOnce();
});
it('offline local cancel retains exact cancellation intent across restart', async () => {
  const f = fixture();
  await f.service.enable();
  const id = f.request();
  await f.service.sync();
  f.fail('v2/work/cancel');
  await expect(f.service.cancel(id, f.saved().revision)).rejects.toThrow();
  const pending = f.saved().value.pendingCancel;
  expect(pending).not.toBeNull();
  expect(() => f.service.executionBinding(id)).toThrow();
  f.restart();
  await f.service.sync();
  expect(f.calls.filter(c => c.route.endsWith('/cancel')).map(c => c.body)).toEqual([pending, pending]);
  expect(f.saved().value.pendingCancel).toBeNull();
  expect(f.dispatch).not.toHaveBeenCalled();
});
it('an unreviewed person decision is rejected before it can become local execution authority', async () => {
  const f = fixture();
  await f.service.enable();
  f.request();
  await f.service.sync();
  f.decide();
  const wrong = structuredClone(f.state);
  wrong.review!.decision!.person.subject = randomUUID();
  f.setState(wrong);
  await expect(f.service.sync()).rejects.toThrow();
  expect(f.dispatch).not.toHaveBeenCalled();
});
it('same executor UUID cannot be ingested under both protocols', async () => {
  const f = fixture();
  await f.service.enable();
  const id = f.request();
  f.db.create('website-request', `website-request:${id}`, { unrelated: 'protocol one evidence' }, 5000);
  await expect(f.service.sync()).rejects.toThrow(/protocol/);
  expect(f.preview).not.toHaveBeenCalled();
});
it('restored approved review cannot regain work authority or be uploaded', async () => {
  const f = fixture();
  await f.service.enable();
  f.request();
  await f.service.sync();
  f.decide();
  const row = f.saved();
  const restored = restoreWebsiteRemoteWork(row.id, row.value, new Date().toISOString());
  f.db.update(WEBSITE_REMOTE_WORK_KIND, row.id, row.revision, () => restored);
  await f.service.sync();
  expect(f.dispatch).not.toHaveBeenCalled();
  expect(f.calls.filter(c => c.route.endsWith('/review'))).toHaveLength(1);
});
it('revoked approver status reconciles inactive work under hold without preparing or dispatching', async () => {
  const f = fixture();
  await f.service.enable();
  f.request();
  await f.service.sync();
  const stale = { ...f.state, phase: 'stale' as const, outcome: 'binding-changed' as const, revision: f.state.revision + 1, sequence: f.state.sequence + 1 };
  f.setState(stale);
  f.change();
  await expect(f.service.sync()).rejects.toThrow();
  expect(f.service.list().records[0]!.phase).toBe('stale');
  expect(f.preview).toHaveBeenCalledOnce();
  expect(f.dispatch).not.toHaveBeenCalled();
});
it('revocation while running cancels the existing executor and reports its outcome', async () => {
  const f = fixture();
  await f.service.enable();
  const id = f.request();
  await f.service.sync();
  f.decide();
  await f.service.sync();
  f.change();
  await expect(f.service.sync()).rejects.toThrow();
  expect(f.options.cancel).toHaveBeenCalledOnce();
  expect(f.runs.get(id)?.phase).toBe('cancelled');
  expect(f.saved().value.remote.phase).toBe('cancelled');
  expect(() => f.service.executionBinding(id)).toThrow();
});
it('accepted cancellation retains an interrupted local outcome when dispatch cannot be proved', async () => {
  const f = fixture();
  await f.service.enable();
  const id = f.request();
  await f.service.sync();
  f.decide();
  f.fail('v2/work/claim');
  await expect(f.service.sync()).rejects.toThrow();
  f.mutate((route, result) => {
    if (route.endsWith('/cancel')) {
      result.phase = 'accepted';
      result.outcome = null;
    }
  });
  await f.service.cancel(id, f.saved().revision);
  expect(f.saved().value.phase).toBe('interrupted');
  expect(f.service.list().records[0]!.cancellationRequested).toBe(true);
  expect(f.dispatch).not.toHaveBeenCalled();
});

it('nullable persisted authority fields reject undefined and non-object values', async () => {
  const f = fixture(); await f.service.enable(); f.request(); await f.service.sync();
  const row = f.saved();
  for (const field of ['preview', 'publication', 'intent', 'run', 'pendingEvent', 'pendingCancel']) {
    for (const value of [undefined, false, [], '']) expect(() => validateSavedWebsiteRemoteWork(row.id, {...row.value, [field]: value})).toThrow();
  }
});

it('accepted cancellation reports a proved completed executor after lost running acknowledgement', async () => {
 const f = fixture(); await f.service.enable(); const id = f.request(); await f.service.sync(); f.decide();
 f.failBefore('v2/work/ack'); await expect(f.service.sync()).rejects.toThrow();
 expect(f.state.phase).toBe('accepted'); expect(f.dispatch).toHaveBeenCalledOnce();
 const run = f.runs.get(id)!; f.runs.set(id, {...run, phase:'completed', outcome:'prepared'});
 await f.service.cancel(id, f.saved().revision); await f.service.sync();
 expect(f.saved().value.remote.phase).toBe('completed'); expect(f.saved().value.remote.cancellationRequested).toBe(true);
 expect(f.dispatch).toHaveBeenCalledOnce(); expect(f.calls.filter(c => c.route.endsWith('/claim'))).toHaveLength(1);
});

it('cold recovery retries the exact interrupted receipt after a committed claim and lost interruption reply', async () => {
  const f = fixture(); await f.service.enable(); f.request(); await f.service.sync(); f.decide();
  f.fail('v2/work/claim'); await expect(f.service.sync()).rejects.toThrow();
  expect(f.state.phase).toBe('accepted'); expect(f.saved().value.run).toBeNull();
  f.restart(); f.fail('v2/work/ack'); await expect(f.service.sync()).rejects.toThrow();
  const pending = f.saved().value.pendingEvent;
  expect(pending).toMatchObject({phase:'interrupted',outcome:'execution-interrupted',runReference:null});
  expect(f.state.phase).toBe('interrupted');
  f.restart(); await f.service.sync();
  expect(f.saved().value.remote.phase).toBe('interrupted'); expect(f.saved().value.pendingEvent).toBeNull();
  expect(f.calls.filter(c => c.route.endsWith('/ack')).slice(-2).map(c => c.body)).toEqual([pending,pending]);
  expect(f.calls.filter(c => c.route.endsWith('/claim'))).toHaveLength(1);
  expect(f.dispatch).not.toHaveBeenCalled(); expect(f.runs.size).toBe(0);
});
