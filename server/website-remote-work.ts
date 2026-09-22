/** Protocol 2 orchestration. Private previews never cross the disclosure boundary. */
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { canonicalWebsiteCommand, commandUuid, commandDigest, commandLabel, COMMAND_PHASES, COMMAND_OUTCOMES, type WebsiteCommandPhase, type WebsiteCommandOutcome } from '../shared/website-commands.ts';
import { remoteExact, remoteIso, isRemoteCommandGrant, isRemoteApproverScope, type RemoteCommandGrant, type RemoteApproverScope } from '../shared/website-remote-approvers.ts';
import { isRemoteDisclosureTemplate, type RemoteDisclosureTemplate } from '../shared/website-remote-disclosure.ts';
import { isRemoteWorkEnvelope, isRemoteWorkState, isRemoteWorkPublish, isRemoteWorkClaim, isRemoteWorkEvent, isRemoteWorkDesktopCancel, isRemoteWorkPollResult, isRemoteWorkClaimResult, isRemoteWorkReviewResult, type RemoteWorkEnvelope, type RemoteWorkState, type RemoteWorkPublish, type RemoteWorkClaim, type RemoteWorkEvent, type RemoteWorkDesktopCancel } from '../shared/website-remote-work.ts';
import { readPrivateJson, writePrivateJson } from './private-json.ts';
import { createWebsiteRequestsTransport, WebsiteRequestsTransportError } from './website-requests-transport.ts';
import type { WorkflowRecord } from './workflow-database.ts';
import type { RemoteWorkAuthority } from './website-remote-approvers.ts';
import type { WebsiteRequestsOptions, WebsiteRequestIdentity, WebsiteRequestPreviewContent, WebsiteRequestRun, WebsiteRequestExecution } from './website-requests.ts';
export const WEBSITE_REMOTE_WORK_KIND = 'website-remote-work';
const same = (a: unknown, b: unknown) => canonicalWebsiteCommand(a) === canonicalWebsiteCommand(b);
const hash = (v: unknown) => createHash('sha256').update(canonicalWebsiteCommand(v)).digest('hex');
const fail = (message = 'Remote work history needs recovery. No work was started.', status = 409): never => {
  throw Object.assign(new Error(message), { status });
};
const uuid = (v: unknown): v is string => typeof v === 'string' && commandUuid.test(v);
const digest = (v: unknown): v is string => typeof v === 'string' && commandDigest.test(v);
const identity = (v: unknown): v is WebsiteRequestIdentity => remoteExact(v, ['workspaceId', 'workerProfileKey']) && uuid(v.workspaceId) && (v.workerProfileKey === null || typeof v.workerProfileKey === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v.workerProfileKey));
const terminal = (p: string) => ['completed', 'needs-review', 'partial', 'failed', 'interrupted', 'rejected', 'cancelled', 'expired', 'stale'].includes(p);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const validRun = (v: unknown): v is WebsiteRequestRun => remoteExact(v, ['id', 'phase', 'outcome']) && typeof v.id === 'string' && /^[A-Za-z0-9:_-]{1,180}$/.test(v.id) && typeof v.phase === 'string' && ['running', 'completed', 'needs-review', 'partial', 'failed', 'interrupted', 'cancelled'].includes(v.phase) && (v.outcome === null || typeof v.outcome === 'string' && COMMAND_OUTCOMES.includes(v.outcome as WebsiteCommandOutcome));
function content(v: unknown): v is WebsiteRequestPreviewContent {
  return remoteExact(v, ['title', 'details', 'binding']) && commandLabel(v.title, 160) && Array.isArray(v.details) && v.details.length <= 64 && v.details.every(d => remoteExact(d, ['label', 'value']) && commandLabel(d.label, 160) && typeof d.value === 'string' && d.value.length <= 8192) && object(v.binding) && Buffer.byteLength(JSON.stringify(v)) <= 64000 && Buffer.byteLength(JSON.stringify(v.binding)) <= 32000;
}
type Preview = WebsiteRequestPreviewContent & {
  digest: string;
  createdAt: string;
};
type Settings = {
  version: 2;
  enabled: boolean;
  activationId: string;
  parent: RemoteCommandGrant;
  commandToken: string;
  identity: WebsiteRequestIdentity;
  authority: string;
  scopes: RemoteApproverScope[];
  cursor: number;
};
export type SavedWebsiteRemoteWork = {
  version: 2;
  envelope: RemoteWorkEnvelope;
  envelopeDigest: string;
  identity: WebsiteRequestIdentity;
  authority: string;
  activationId: string;
  remote: RemoteWorkState;
  phase: WebsiteCommandPhase;
  outcome: WebsiteCommandOutcome | null;
  preview: Preview | null;
  publication: RemoteWorkPublish | null;
  publicationPending: boolean;
  intent: {
    claim: RemoteWorkClaim;
    stage: 'claim' | 'dispatch';
  } | null;
  run: WebsiteRequestRun | null;
  runReference: string | null;
  pendingEvent: RemoteWorkEvent | null;
  pendingCancel: RemoteWorkDesktopCancel | null;
  cancellationRequested: boolean;
  restored: boolean;
  updatedAt: string;
};
function previewHash(v: Pick<SavedWebsiteRemoteWork, 'envelopeDigest' | 'identity' | 'activationId'>, p: WebsiteRequestPreviewContent) {
  return hash({ envelopeDigest: v.envelopeDigest, identity: v.identity, activationId: v.activationId, content: p });
}
export function validateSavedWebsiteRemoteWork(id: string, v: unknown): SavedWebsiteRemoteWork {
  if (!remoteExact(v, ['version', 'envelope', 'envelopeDigest', 'identity', 'authority', 'activationId', 'remote', 'phase', 'outcome', 'preview', 'publication', 'publicationPending', 'intent', 'run', 'runReference', 'pendingEvent', 'pendingCancel', 'cancellationRequested', 'restored', 'updatedAt']) || v.version !== 2 || !isRemoteWorkEnvelope(v.envelope) || id !== `website-remote-work:${v.envelope.id}` || v.envelopeDigest !== hash(v.envelope) || !identity(v.identity) || v.identity.workspaceId !== v.envelope.workspaceId || !digest(v.authority) || !uuid(v.activationId) || !isRemoteWorkState(v.remote) || !same(v.remote.envelope, v.envelope) || typeof v.phase !== 'string' || !COMMAND_PHASES.includes(v.phase as WebsiteCommandPhase) || !(v.outcome === null || typeof v.outcome === 'string' && COMMAND_OUTCOMES.includes(v.outcome as WebsiteCommandOutcome)) || typeof v.publicationPending !== 'boolean' || typeof v.cancellationRequested !== 'boolean' || typeof v.restored !== 'boolean' || !remoteIso(v.updatedAt))
    return fail(undefined, 503);
  const s = v as SavedWebsiteRemoteWork;
  for (const field of ['preview', 'publication', 'intent', 'run', 'pendingEvent', 'pendingCancel'] as const) {
    if (s[field] !== null && !object(s[field])) return fail(undefined, 503);
  }
  if (s.preview) {
    const p = s.preview;
    if (!remoteExact(p, ['title', 'details', 'binding', 'digest', 'createdAt']) || !remoteIso(p.createdAt) || !content({ title: p.title, details: p.details, binding: p.binding }) || p.digest !== previewHash(s, { title: p.title, details: p.details, binding: p.binding }))
      return fail(undefined, 503);
  }
  if (s.publication) {
    const p = s.publication, r = p.review;
    if (!isRemoteWorkPublish(p) || p.requestId !== s.envelope.id || p.grantId !== s.envelope.grantId || p.generation !== s.envelope.generation || !s.preview || r.previewDigest !== s.preview.digest || r.activationId !== s.activationId || !same(r.template.descriptor, s.envelope.descriptor) || r.templateDigest !== hash(r.template) || p.reviewDigest !== hash(r) || r.expiresAt > s.envelope.expiresAt)
      return fail(undefined, 503);
  }
  if (s.publication && s.remote.review) {
    const r = s.remote.review, p = s.publication;
    if (r.id !== p.review.reviewId || r.digest !== p.reviewDigest || r.expiresAt !== p.review.expiresAt || r.decision && !p.review.audience.some(a => a.enrollmentId === r.decision!.enrollmentId && same(a.person, r.decision!.person)))
      return fail(undefined, 503);
  }
  if (s.publicationPending && !s.publication)
    return fail(undefined, 503);
  if (s.intent && (!remoteExact(s.intent, ['claim', 'stage']) || !['claim', 'dispatch'].includes(s.intent.stage) || !isRemoteWorkClaim(s.intent.claim) || !s.publication || s.intent.claim.requestId !== s.envelope.id || s.intent.claim.grantId !== s.envelope.grantId || s.intent.claim.generation !== s.envelope.generation || s.intent.claim.activationId !== s.activationId || s.intent.claim.reviewId !== s.publication.review.reviewId || s.intent.claim.reviewDigest !== s.publication.reviewDigest || s.intent.claim.previewDigest !== s.preview?.digest || s.remote.review?.decision?.choice !== 'approve' || s.intent.claim.decisionId !== s.remote.review.decision.decisionId))
    return fail(undefined, 503);
  if (s.run && (!validRun(s.run) || !s.preview || !s.publication || s.remote.review?.decision?.choice !== 'approve') || !(s.runReference === null || uuid(s.runReference)) || s.run && !s.runReference)
    return fail(undefined, 503);
  for (const event of [s.pendingEvent, s.pendingCancel])
    if (event && (event.requestId !== s.envelope.id || event.grantId !== s.envelope.grantId || event.generation !== s.envelope.generation))
      return fail(undefined, 503);
  if (s.pendingEvent && !isRemoteWorkEvent(s.pendingEvent) || s.pendingCancel && (!isRemoteWorkDesktopCancel(s.pendingCancel) || !s.cancellationRequested))
    return fail(undefined, 503);
  if (s.restored && (s.intent || s.pendingEvent || s.pendingCancel || s.publicationPending || !terminal(s.phase)))
    return fail(undefined, 503);
  return structuredClone(s);
}
export function restoreWebsiteRemoteWork(id: string, v: unknown, at: string): SavedWebsiteRemoteWork {
  if (!remoteIso(at))
    return fail();
  const s = validateSavedWebsiteRemoteWork(id, v);
  return { ...s, restored: true, intent: null, pendingEvent: null, pendingCancel: null, publicationPending: false, cancellationRequested: true, phase: terminal(s.phase) ? s.phase : 'interrupted', outcome: terminal(s.phase) ? s.outcome : 'execution-interrupted', updatedAt: at };
}
export interface RemoteWorkOptions extends Pick<WebsiteRequestsOptions, 'directory' | 'db' | 'identity' | 'officeLink' | 'preview' | 'check' | 'dispatch' | 'lookup' | 'cancel' | 'barrier' | 'fetch' | 'now'> {
  authority(): Promise<RemoteWorkAuthority>;
  refreshRemoteSources?(): Promise<void>;
  remoteTemplate?(scope: RemoteApproverScope): Promise<RemoteDisclosureTemplate>;
  exclusive<T>(work: () => Promise<T>, wait?: boolean): Promise<T>;
}
export function createWebsiteRemoteWork(options: RemoteWorkOptions) {
  const path = join(options.directory, 'website-requests', 'remote-work.json'), transport = createWebsiteRequestsTransport(options.fetch), now = options.now ?? Date.now;
  let epoch = 0, stopped = false, recovered = false, busy = false, error: string | null = null;
  const live = new Map<string, {
    authority: RemoteWorkAuthority;
    epoch: number;
    activationId: string;
  }>();
  const stamp = () => new Date(now()).toISOString();
  function validateSettings(v: unknown): Settings {
    if (!remoteExact(v, ['version', 'enabled', 'activationId', 'parent', 'commandToken', 'identity', 'authority', 'scopes', 'cursor']) || v.version !== 2 || typeof v.enabled !== 'boolean' || !uuid(v.activationId) || !isRemoteCommandGrant(v.parent) || v.parent.revokedAt || !digest(v.commandToken) || !identity(v.identity) || v.identity.workspaceId !== v.parent.workspaceId || !digest(v.authority) || !Array.isArray(v.scopes) || !v.scopes.length || v.scopes.length > 16 || !v.scopes.every(isRemoteApproverScope) || new Set(v.scopes.map(s => s.descriptorId)).size !== v.scopes.length || !Number.isSafeInteger(v.cursor) || Number(v.cursor) < 0)
      return fail(undefined, 503);
    return v as Settings;
  }
  async function settings() {
    const v = await readPrivateJson(path, 64000);
    return v === undefined ? null : validateSettings(v);
  }
  async function saveSettings(s: Settings) {
    validateSettings(s);
    await writePrivateJson(path, s);
  }
  function* all() {
    let before: number | undefined;
    do {
      const page = options.db.page<SavedWebsiteRemoteWork>(WEBSITE_REMOTE_WORK_KIND, { before, limit: 200 });
      for (const r of page.records) {
        validateSavedWebsiteRemoteWork(r.id, r.value);
        yield r;
      }
      before = page.next ?? undefined;
    } while (before);
  }
  function get(id: string) {
    if (!uuid(id))
      return fail('Invalid work request.', 400);
    const row = options.db.get<SavedWebsiteRemoteWork>(WEBSITE_REMOTE_WORK_KIND, `website-remote-work:${id}`);
    if (!row)
      return fail('Work request not found.', 404);
    validateSavedWebsiteRemoteWork(row.id, row.value);
    return row;
  }
  function put(row: WorkflowRecord<SavedWebsiteRemoteWork>, changes: Partial<SavedWebsiteRemoteWork>) {
    const next = { ...row.value, ...changes, updatedAt: stamp() };
    validateSavedWebsiteRemoteWork(row.id, next);
    return options.db.update<SavedWebsiteRemoteWork>(WEBSITE_REMOTE_WORK_KIND, row.id, row.revision, () => next);
  }
  function execution(s: SavedWebsiteRemoteWork): WebsiteRequestExecution {
    if (!s.preview)
      return fail();
    return { descriptor: structuredClone(s.envelope.descriptor), requestId: s.envelope.id, binding: structuredClone(s.preview.binding) };
  }
  function target(s: Settings, state: RemoteWorkState) {
    const e = state.envelope, p = s.parent;
    if (e.grantId !== p.grantId || e.generation !== p.generation || e.companyId !== p.companyId || e.installationId !== p.installationId || e.workspaceId !== p.workspaceId || e.workerBinding !== p.workerBinding || !p.descriptors.some(d => same(d, e.descriptor)))
      return fail('The website returned work for another workspace.', 502);
  }
  async function guard(s: Settings, a: RemoteWorkAuthority, c: number) {
    options.barrier?.();
    if (stopped || epoch !== c || !s.enabled || !same(s.identity, options.identity()) || !same(a.parent, s.parent) || a.authority !== s.authority || !same(a.scopes, s.scopes))
      return fail('Remote sharing or workspace permission changed.');
    await a.assertCurrent();
    const fresh = await settings();
    if (stopped || epoch !== c || !fresh?.enabled || fresh.activationId !== s.activationId || !same(fresh.parent, s.parent) || !a.isCurrent())
      return fail('Remote sharing or workspace permission changed.');
  }
  async function check(s: Settings, a: RemoteWorkAuthority, c: number, row: WorkflowRecord<SavedWebsiteRemoteWork>) {
    await guard(s, a, c);
    const v = row.value;
    if (v.restored || v.cancellationRequested || v.remote.cancellationRequested || v.activationId !== s.activationId || v.authority !== s.authority || !same(v.identity, s.identity) || Date.parse(v.envelope.expiresAt) <= now())
      return fail('This work request is no longer current.');
    target(s, v.remote);
    if (v.preview)
      await options.check(v.envelope.descriptor, structuredClone(v.preview.binding));
    await guard(s, a, c);
  }
  function merge(row: WorkflowRecord<SavedWebsiteRemoteWork>, state: RemoteWorkState) {
    const old = row.value;
    if (!same(old.envelope, state.envelope) || state.revision < old.remote.revision || state.revision === old.remote.revision && !same(state, old.remote))
      return fail('Conflicting work receipt. Refresh status.', 502);
    if (same(state, old.remote))
      return row;
    const inactive = ['cancelled', 'expired', 'stale', 'rejected'].includes(state.phase);
    return put(row, { remote: state, cancellationRequested: old.cancellationRequested || state.cancellationRequested, ...(!old.run && inactive ? { phase: state.phase, outcome: state.outcome, intent: null } : {}) });
  }
  function ingest(s: Settings, state: RemoteWorkState) {
    target(s, state);
    const id = `website-remote-work:${state.envelope.id}`;
    if (options.db.get('website-request', `website-request:${state.envelope.id}`))
      return fail('Conflicting protocol request identity.', 503);
    const row = options.db.get<SavedWebsiteRemoteWork>(WEBSITE_REMOTE_WORK_KIND, id);
    if (row) {
      validateSavedWebsiteRemoteWork(id, row.value);
      return merge(row, state);
    }
    const unowned = state.phase !== 'queued' && state.phase !== 'delivered' || !!state.review;
    const value: SavedWebsiteRemoteWork = { version: 2, envelope: state.envelope, envelopeDigest: hash(state.envelope), identity: s.identity, authority: s.authority, activationId: s.activationId, remote: state, phase: unowned ? 'interrupted' : 'delivered', outcome: unowned ? 'execution-interrupted' : null, preview: null, publication: null, publicationPending: false, intent: null, run: null, runReference: null, pendingEvent: null, pendingCancel: null, cancellationRequested: state.cancellationRequested, restored: false, updatedAt: stamp() };
    validateSavedWebsiteRemoteWork(id, value);
    return options.db.create(WEBSITE_REMOTE_WORK_KIND, id, value, 5000);
  }
  async function reconcile(row: WorkflowRecord<SavedWebsiteRemoteWork>) {
    if (row.value.restored || !row.value.preview || !row.value.intent && !row.value.run)
      return row;
    const found = await options.lookup(execution(row.value));
    if (found) {
      if (!validRun(found) || row.value.run && row.value.run.id !== found.id)
        return fail();
      if (!same(found, row.value.run) || row.value.intent)
        row = put(row, { run: found, runReference: row.value.runReference ?? randomUUID(), phase: found.phase, outcome: found.outcome, intent: null });
    }
    return row;
  }
  async function recoverWithinActivity() {
    if (recovered)
      return;
    for (let row of all()) {
      row = await reconcile(row);
      if (row.value.intent && !row.value.run)
        put(row, { intent: null, phase: 'interrupted', outcome: 'execution-interrupted', cancellationRequested: true });
    }
    recovered = true;
  }
  async function flush(s: Settings, row: WorkflowRecord<SavedWebsiteRemoteWork>) {
    if (row.value.restored || terminal(row.value.remote.phase) && !row.value.pendingEvent)
      return row;
    let v = row.value;
    if (!v.pendingEvent && (v.phase !== v.remote.phase || v.outcome !== v.remote.outcome || v.runReference !== v.remote.runReference)) {
      if (v.phase === 'accepted')
        return row;
      const entering = v.remote.phase === 'accepted' && !!v.run;
      row = put(row, { pendingEvent: { protocol: 2, grantId: v.envelope.grantId, generation: v.envelope.generation, requestId: v.envelope.id, eventId: randomUUID(), expectedRevision: v.remote.revision, phase: entering ? 'running' : v.phase, outcome: entering ? null : v.outcome, runReference: v.runReference } });
    }
    const event = row.value.pendingEvent;
    if (!event)
      return row;
    let state: RemoteWorkState;
    try {
      state = await transport.post('v2/work/ack', s.commandToken, event, v => isRemoteWorkState(v) ? v : fail('Invalid work status receipt.', 502));
    }
    catch (cause) {
      if (cause instanceof WebsiteRequestsTransportError && cause.status === 409)
        return put(row, { pendingEvent: null });
      throw cause;
    }
    target(s, state);
    if (!same(state.envelope, row.value.envelope) || state.revision !== event.expectedRevision + 1 || state.phase !== event.phase || state.outcome !== event.outcome || state.runReference !== event.runReference)
      return fail('Inconsistent work status receipt.', 502);
    row = put(row, { remote: state.revision >= row.value.remote.revision ? state : row.value.remote, pendingEvent: null });
    if (state.phase === 'running' && row.value.phase !== 'running')
      return flush(s, row);
    return row;
  }
  async function cancellation(s: Settings, row: WorkflowRecord<SavedWebsiteRemoteWork>, retry = true) {
    if (row.value.restored)
      return row;
    row = await reconcile(row);
    if (row.value.run?.phase === 'running') {
      await options.cancel(row.value.run);
      row = await reconcile(row);
    }
    if (!row.value.cancellationRequested)
      row = put(row, { cancellationRequested: true });
    if (!row.value.pendingCancel && !row.value.remote.cancellationRequested)
      row = put(row, { pendingCancel: { protocol: 2, grantId: row.value.envelope.grantId, generation: row.value.envelope.generation, requestId: row.value.envelope.id, cancelId: randomUUID(), expectedRevision: row.value.remote.revision } });
    const pending = row.value.pendingCancel;
    if (pending) {
      const link = await options.officeLink.credentials();
      if (!link || link.companyId !== s.parent.companyId || link.installationId !== s.parent.installationId || !same(options.identity(), s.identity))
        return fail('Restore the original workspace link to confirm cancellation.');
      let state: RemoteWorkState;
      try {
        state = await transport.post('v2/work/cancel', s.commandToken, pending, v => isRemoteWorkState(v) ? v : fail('Invalid cancellation receipt.', 502));
      }
      catch (cause) {
        if (retry && cause instanceof WebsiteRequestsTransportError && cause.status === 409) {
          let cursor = Math.max(0, row.value.remote.sequence - 1);
          for (let page = 0; page < 8; page++) {
            const result = await transport.post('v2/work/poll', s.commandToken, { protocol: 2, grantId: s.parent.grantId, generation: s.parent.generation, cursor }, v => isRemoteWorkPollResult(v) ? v : fail('Invalid cancellation status.', 502));
            const found = result.requests.find(r => r.envelope.id === row.value.envelope.id);
            if (found) {
              target(s, found);
              row = merge(row, found);
              row = put(row, { pendingCancel: null });
              return cancellation(s, row, false);
            }
            if (!result.hasMore || result.cursor <= cursor)
              break;
            cursor = result.cursor;
          }
        }
        throw cause;
      }
      target(s, state);
      if (!same(state.envelope, row.value.envelope) || !state.cancellationRequested || ![pending.expectedRevision, pending.expectedRevision + 1].includes(state.revision))
        return fail('Cancellation was not confirmed.', 502);
      row = put(row, { remote: state.revision >= row.value.remote.revision ? state : row.value.remote, pendingCancel: null, publicationPending: false, intent: null, ...(!row.value.run ? { phase: state.phase === 'cancelled' ? 'cancelled' : 'interrupted', outcome: state.phase === 'cancelled' ? 'cancelled' : 'execution-interrupted' } : {}) });
    }
    // A committed claim with no durable executor is an interrupted attempt,
    // not a running job. Report that uncertainty using its null run reference.
    if (row.value.pendingEvent || ['accepted', 'running'].includes(row.value.remote.phase) && (row.value.run || row.value.phase === 'interrupted' && row.value.remote.runReference === null))
      row = await flush(s, row);
    return row;
  }
  async function prepare(s: Settings, a: RemoteWorkAuthority, c: number, row: WorkflowRecord<SavedWebsiteRemoteWork>, serverTime: string) {
    await check(s, a, c, row);
    if (row.value.publication)
      return row;
    const d = row.value.envelope.descriptor, scope = s.scopes.find(scope => scope.descriptorId === d.id && scope.descriptorRevision === d.revision);
    if (!scope || !options.remoteTemplate)
      return fail('Review the disclosure template before sharing work.');
    const template = await options.remoteTemplate(scope);
    await check(s, a, c, row);
    if (!isRemoteDisclosureTemplate(template) || hash(template) !== scope.disclosureDigest || !same(template.descriptor, d))
      return fail('The disclosure template changed.');
    const p = await options.preview(structuredClone(d));
    await check(s, a, c, row);
    if (!content(p))
      return fail();
    const preview = { ...structuredClone(p), createdAt: stamp(), digest: previewHash(row.value, p) };
    const eligible = a.approvers.filter(g => g.scopes.some(s => same(s, scope)));
    const unique = new Map<string, typeof eligible[number]>();
    for (const g of eligible)
      if (!unique.has(g.person.subject))
        unique.set(g.person.subject, g);
    const audience = [...unique.values()].map(g => ({ enrollmentId: g.id, generation: 1 as const, person: g.person })).sort((x, y) => x.enrollmentId.localeCompare(y.enrollmentId));
    if (!audience.length)
      return fail('No current approver can review this work.');
    const review = { protocol: 2 as const, reviewId: randomUUID(), requestId: row.value.envelope.id, grantId: s.parent.grantId, generation: s.parent.generation, activationId: s.activationId, previewDigest: preview.digest, previewRevision: row.revision + 1, descriptorId: d.id, descriptorRevision: d.revision, template, templateDigest: scope.disclosureDigest, audience, createdAt: serverTime, expiresAt: row.value.envelope.expiresAt };
    const publication: RemoteWorkPublish = { protocol: 2, grantId: s.parent.grantId, generation: s.parent.generation, requestId: review.requestId, expectedRevision: row.value.remote.revision, review, reviewDigest: hash(review) };
    row = put(row, { preview, publication, publicationPending: true });
    return row;
  }
  async function publish(s: Settings, a: RemoteWorkAuthority, c: number, row: WorkflowRecord<SavedWebsiteRemoteWork>) {
    if (!row.value.publicationPending)
      return row;
    await check(s, a, c, row);
    const body = row.value.publication!;
    const receipt = await transport.post('v2/work/review', s.commandToken, body, v => isRemoteWorkReviewResult(v) ? v : fail('Invalid review receipt.', 502));
    if (!same(receipt.review, body.review))
      return fail('The website returned another review.', 502);
    const state = receipt.request;
    await check(s, a, c, row);
    target(s, state);
    if (!same(state.envelope, row.value.envelope) || state.revision < body.expectedRevision + 1 || state.review?.id !== body.review.reviewId || state.review.digest !== body.reviewDigest || state.review.expiresAt !== body.review.expiresAt)
      return fail('The website returned another review.', 502);
    if (state.revision >= row.value.remote.revision)
      row = merge(row, state);
    return put(row, { publicationPending: false });
  }
  async function dispatch(s: Settings, a: RemoteWorkAuthority, c: number, row: WorkflowRecord<SavedWebsiteRemoteWork>) {
    const v = row.value, p = v.publication, decision = v.remote.review?.decision;
    if (!p || !decision || decision.choice !== 'approve' || v.publicationPending || v.run || terminal(v.phase))
      return row;
    await check(s, a, c, row);
    if (v.remote.review?.prunedAt || Date.parse(p.review.expiresAt) <= now() || decision.reviewId !== p.review.reviewId || decision.reviewDigest !== p.reviewDigest || !p.review.audience.some(person => person.enrollmentId === decision.enrollmentId && same(person.person, decision.person)) || !a.approvers.some(g => g.id === decision.enrollmentId && same(g.person, decision.person) && g.scopes.some(scope => scope.disclosureDigest === p.review.templateDigest && scope.descriptorId === p.review.descriptorId)))
      return fail('This decision is no longer authorized. Request a new review.');
    const found = await options.lookup(execution(v));
    await check(s, a, c, row);
    if (found) {
      if (!validRun(found))
        return fail();
      return put(row, { run: found, runReference: randomUUID(), intent: null, phase: found.phase, outcome: found.outcome });
    }
    const claim = v.intent?.claim ?? { protocol: 2 as const, grantId: s.parent.grantId, generation: s.parent.generation, requestId: v.envelope.id, expectedRevision: v.remote.revision, claimId: randomUUID(), reviewId: p.review.reviewId, reviewDigest: p.reviewDigest, decisionId: decision.decisionId, previewDigest: v.preview!.digest, activationId: s.activationId };
    row = put(row, { intent: { claim, stage: 'claim' } });
    const started = now();
    const receipt = await transport.post('v2/work/claim', s.commandToken, claim, v => isRemoteWorkClaimResult(v) ? v : fail('Invalid execution permission.', 502));
    const duration = Date.parse(receipt.validUntil) - Date.parse(receipt.serverTime);
    if (!same(receipt.request.envelope, row.value.envelope) || receipt.claimId !== claim.claimId || receipt.reviewId !== claim.reviewId || receipt.reviewDigest !== claim.reviewDigest || receipt.decisionId !== claim.decisionId || receipt.previewDigest !== claim.previewDigest || receipt.activationId !== claim.activationId || receipt.request.phase !== 'accepted' || receipt.request.cancellationRequested || receipt.request.revision !== claim.expectedRevision + 1 || duration <= 0 || duration > 60000)
      return fail('Inconsistent execution permission.', 502);
    row = put(row, { remote: receipt.request, phase: 'accepted', outcome: null, intent: { claim, stage: 'dispatch' } });
    try {
      await check(s, a, c, row);
      if (now() - started >= duration || Date.parse(receipt.validUntil) <= now())
        return fail('Execution permission expired. Request a new review.');
      live.set(v.envelope.id, { authority: a, epoch: c, activationId: s.activationId });
      const run = await options.dispatch(execution(row.value));
      if (!validRun(run))
        return fail();
      row = put(row, { run, runReference: randomUUID(), intent: null, phase: run.phase, outcome: run.outcome });
    }
    catch (cause) {
      row = await reconcile(row);
      if (!row.value.run)
        row = put(row, { intent: null, phase: 'interrupted', outcome: 'execution-interrupted', cancellationRequested: true });
      throw cause;
    }
    return row;
  }
  async function reconcileHeld(s: Settings) {
    live.clear();
    const readGuard = async () => {
      options.barrier?.();
      const link = await options.officeLink.credentials();
      if (stopped || !same(options.identity(), s.identity) || !link || link.installationId !== s.parent.installationId || link.companyId !== s.parent.companyId)
        return fail('Restore the original workspace link to refresh work status.');
    };
    await readGuard();
    let cursor = s.cursor;
    for (let page = 0; page < 8; page++) {
      const result = await transport.post('v2/work/poll', s.commandToken, { protocol: 2, grantId: s.parent.grantId, generation: s.parent.generation, cursor }, v => isRemoteWorkPollResult(v) ? v : fail('Invalid held work status.', 502));
      await readGuard();
      const { revokedAt: _revoked, ...parent } = result.grant, { revokedAt: _saved, ...expected } = s.parent;
      if (!same(parent, expected) || result.cursor < cursor || result.hasMore && result.cursor === cursor)
        return fail('Another workspace returned work status.', 502);
      for (const state of result.requests) {
        target(s, state);
        const row = options.db.get<SavedWebsiteRemoteWork>(WEBSITE_REMOTE_WORK_KIND, `website-remote-work:${state.envelope.id}`);
        if (row && !row.value.restored) {
          validateSavedWebsiteRemoteWork(row.id, row.value);
          merge(row, state);
        }
      }
      cursor = result.cursor;
      if (!result.hasMore)
        break;
    }
    // Running executors lose their live provider fence immediately; finish local
    // cancellation through the same executor, even if the website is inactive.
    for (let row of all())
      if (!row.value.restored && row.value.envelope.grantId === s.parent.grantId && row.value.run?.phase === 'running') {
        row = put(row, { cancellationRequested: true });
        await options.cancel(row.value.run!);
        row = await reconcile(row);
        await cancellation(s, row);
      }
  }
  async function syncWithinActivity() {
    await recoverWithinActivity();
    const s = await settings();
    if (!s)
      return;
    const matching = (row: WorkflowRecord<SavedWebsiteRemoteWork>) => row.value.envelope.grantId === s.parent.grantId && !row.value.restored;
    for (let row of all())
      if (matching(row)) {
        row = await reconcile(row);
        if (!s.enabled || row.value.cancellationRequested || row.value.pendingCancel) {
          if (!terminal(row.value.phase) || row.value.pendingCancel || row.value.pendingEvent || row.value.cancellationRequested && (!row.value.remote.cancellationRequested || ['accepted', 'running'].includes(row.value.remote.phase) && (!!row.value.run || row.value.phase === 'interrupted' && row.value.remote.runReference === null)))
            await cancellation(s, row);
        }
        else if (row.value.pendingEvent)
          await flush(s, row);
      }
    if (!s.enabled)
      return;
    const c = epoch;
    await options.refreshRemoteSources?.();
    if (stopped || epoch !== c)
      return fail('Remote work permission changed.');
    let a: RemoteWorkAuthority;
    try {
      a = await options.authority();
      await guard(s, a, c);
    }
    catch (cause) {
      await reconcileHeld(s);
      throw cause;
    }
    let serverTime = stamp();
    for (let page = 0; page < 8; page++) {
      const result = await transport.post('v2/work/poll', s.commandToken, { protocol: 2, grantId: s.parent.grantId, generation: s.parent.generation, cursor: s.cursor }, v => isRemoteWorkPollResult(v) ? v : fail('Invalid remote work page.', 502));
      if (!same(result.grant, s.parent) || result.cursor < s.cursor || result.requests.some(r => r.sequence > result.cursor) || result.hasMore && result.cursor === s.cursor)
        return fail('Inconsistent remote work page.', 502);
      await guard(s, a, c);
      serverTime = result.serverTime;
      for (const state of result.requests)
        ingest(s, state);
      s.cursor = result.cursor;
      await saveSettings(s);
      if (!result.hasMore)
        break;
    }
    for (let row of all())
      if (matching(row)) {
        row = await reconcile(row);
        if (row.value.activationId !== s.activationId || row.value.cancellationRequested || row.value.remote.cancellationRequested) {
          if (!terminal(row.value.phase) || row.value.pendingCancel || row.value.pendingEvent || row.value.cancellationRequested && (!row.value.remote.cancellationRequested || ['accepted', 'running'].includes(row.value.remote.phase) && (!!row.value.run || row.value.phase === 'interrupted' && row.value.remote.runReference === null)))
            await cancellation(s, row);
          continue;
        }
        if (terminal(row.value.phase)) {
          if (row.value.run)
            await flush(s, row);
          continue;
        }
        if (Date.parse(row.value.envelope.expiresAt) <= now()) {
          row = put(row, { phase: 'expired', outcome: 'expired', intent: null });
          await flush(s, row);
          continue;
        }
        if (!row.value.run) {
          row = await prepare(s, a, c, row, serverTime);
          row = await publish(s, a, c, row);
          row = await dispatch(s, a, c, row);
        }
        await flush(s, row);
      }
  }
  function view(row: WorkflowRecord<SavedWebsiteRemoteWork>) {
    const v = row.value;
    return { id: v.envelope.id, revision: row.revision, descriptor: v.envelope.descriptor, phase: v.phase, outcome: v.outcome, createdAt: v.envelope.createdAt, expiresAt: v.envelope.expiresAt, review: v.remote.review, sharingPending: v.publicationPending, cancellationPending: !!v.pendingCancel, cancellationRequested: v.cancellationRequested || v.remote.cancellationRequested, restored: v.restored };
  }
  function list(input: {
    before?: number;
    limit?: number;
  } = {}) {
    const p = options.db.page<SavedWebsiteRemoteWork>(WEBSITE_REMOTE_WORK_KIND, { before: input.before, limit: input.limit ?? 50 });
    return {
      records: p.records.map(r => {
        validateSavedWebsiteRemoteWork(r.id, r.value);
        return view(r);
      }), next: p.next
    };
  }
  async function status() {
    const s = await settings();
    let held = false;
    if (s?.enabled)
      try {
        await guard(s, await options.authority(), epoch);
      }
      catch {
        held = true;
      }
    return { workspaceLabel: s?.parent.workspaceLabel ?? null, scopes: s?.scopes ?? [], descriptors: s?.parent.descriptors ?? [], busy, enabled: !!s?.enabled && !stopped, ready: !!s?.enabled && !stopped && !held, activationId: s?.activationId ?? null, error: held ? 'Remote work is on hold. Check this workspace’s sources, settings and approver access.' : error, pendingCancellations: [...all()].filter(r => r.value.pendingCancel).length };
  }
  const run = <T>(work: () => Promise<T>, wait = false) => options.exclusive(async () => {
    busy = true;
    try {
      const value = await work();
      error = null;
      return value;
    }
    catch (cause) {
      error = 'Remote work could not be confirmed. Refresh saved status before retrying.';
      throw cause;
    }
    finally {
      busy = false;
    }
  }, wait);
  async function enable() {
    return run(async () => {
      const prior = await settings();
      if (prior?.enabled)
        return status();
      await recoverWithinActivity();
      const c = epoch;
      await options.refreshRemoteSources?.();
      if (stopped || epoch !== c)
        return fail('Remote work permission changed.');
      const a = await options.authority();
      await a.assertCurrent();
      if (stopped || epoch !== c)
        return fail('Remote work permission changed.');
      const s: Settings = { version: 2, enabled: true, activationId: randomUUID(), parent: a.parent, commandToken: a.commandToken, identity: a.identity, authority: a.authority, scopes: a.scopes, cursor: 0 };
      await saveSettings(s);
      await guard(s, a, c);
      return status();
    });
  }
  async function disableWithinActivity() {
    const s = await settings();
    if (!s)
      return status();
    s.enabled = false;
    await saveSettings(s);
    let failure: unknown;
    for (let row of all())
      if (!row.value.restored && row.value.envelope.grantId === s.parent.grantId && !terminal(row.value.phase)) {
        row = put(row, { cancellationRequested: true });
        try {
          await cancellation(s, row);
        }
        catch (cause) {
          failure = cause;
        }
      }
    if (failure)
      throw failure;
    return status();
  }
  function invalidate() {
    epoch++;
    live.clear();
    transport.abort();
  }
  async function disable() {
    invalidate();
    return run(disableWithinActivity, true);
  }
  async function cancel(id: string, revision: number) {
    invalidate();
    return run(async () => {
      let row = get(id);
      if (row.revision !== revision)
        return fail('This request changed. Refresh before cancelling.');
      if (row.value.restored)
        return fail('Restored history cannot control work.');
      row = put(row, { cancellationRequested: true });
      const s = await settings();
      if (!s || s.parent.grantId !== row.value.envelope.grantId)
        return fail('The original remote permission is required to confirm cancellation.');
      return view(await cancellation(s, row));
    }, true);
  }
  function executionBinding(id: string): WebsiteRequestExecution | null {
    if (!uuid(id))
      return null;
    const row = options.db.get<SavedWebsiteRemoteWork>(WEBSITE_REMOTE_WORK_KIND, `website-remote-work:${id}`);
    if (!row)
      return null;
    const v = validateSavedWebsiteRemoteWork(row.id, row.value), f = live.get(id);
    if (stopped || !f || f.epoch !== epoch || !f.authority.isCurrent() || v.activationId !== f.activationId || v.restored || v.cancellationRequested || v.remote.cancellationRequested || !v.publication || v.remote.review?.decision?.choice !== 'approve' || v.intent?.stage !== 'dispatch' && !v.run)
      return fail('Remote execution permission is no longer active.');
    return execution(v);
  }
  return {
    status, list, enable, disable, cancel, sync: () => run(syncWithinActivity), syncWithinActivity, recoverWithinActivity, disableWithinActivity, invalidate, executionBinding, start() {
      stopped = false;
    }, stop() {
      stopped = true;
      invalidate();
    }
  };
}
export type RemoteWorkStatus = Awaited<ReturnType<ReturnType<typeof createWebsiteRemoteWork>['status']>>;
export type RemoteWorkList = ReturnType<ReturnType<typeof createWebsiteRemoteWork>['list']>;
export type RemoteWorkView = RemoteWorkList['records'][number];
