import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  canonicalWebsiteCommand, commandDigest, commandLabel, commandUuid,
  isWebsiteCommandDescriptor, isWebsiteCommandEnrollment, isWebsiteCommandEnvelope, isWebsiteCommandGrant,
  isWebsiteCommandState, isWebsiteCommandEvent, isWebsiteCommandClaim, isWebsiteCommandClaimResult, isWebsiteCommandPollResult,
  type WebsiteCommandDescriptor, type WebsiteCommandEnrollment, type WebsiteCommandEnvelope, type WebsiteCommandGrant,
  type WebsiteCommandState, type WebsiteCommandEvent, type WebsiteCommandClaim, type WebsiteCommandPhase, type WebsiteCommandOutcome, type WebsiteCommandPollResult,
} from '../shared/website-commands.ts';
import { readPrivateJson, writePrivateJson } from './private-json.ts';
import { WorkflowDatabase, type WorkflowRecord } from './workflow-database.ts';
import { createWebsiteRequestsTransport, WebsiteRequestsTransportError } from './website-requests-transport.ts';
import type { OfficeLinkCredentials } from './office-link.ts';
import { createWebsiteRemoteWork } from './website-remote-work.ts';
import { createWebsiteRemoteApprovers, isRemoteModeMarker, REMOTE_STATE_FILE, type RemoteModeMarker } from './website-remote-approvers.ts';

export const WEBSITE_REQUEST_KIND = 'website-request';
export type WebsiteRequestsStatus = {remoteMode?:boolean;enabled:boolean;pending:boolean;linked:boolean;workspaceId:string;workspaceLabel:string|null;grant:WebsiteCommandGrant|null;error:string|null;busy:boolean;catalog:WebsiteCommandDescriptor[];publishedDescriptors:WebsiteCommandDescriptor[]};
export type WebsiteRequestIdentity = { workspaceId: string; workerProfileKey: string | null };
export type WebsiteRequestPreviewContent = { title: string; details: { label: string; value: string }[]; binding: Record<string, unknown> };
export type WebsiteRequestPreview = WebsiteRequestPreviewContent & { digest: string; createdAt: string };
export type WebsiteRequestRun = { id: string; phase: 'running' | 'completed' | 'needs-review' | 'partial' | 'failed' | 'interrupted' | 'cancelled'; outcome: WebsiteCommandOutcome | null };
export type WebsiteRequestExecution = { descriptor: WebsiteCommandDescriptor; requestId: string; binding: Record<string, unknown> };
export interface WebsiteRequestsOptions {
  directory: string;
  db: WorkflowDatabase;
  officeLink: { credentials(): Promise<OfficeLinkCredentials | null> };
  identity(): WebsiteRequestIdentity;
  getCatalog(): Promise<WebsiteCommandDescriptor[]>;
  onRemoteEvidence?:import('./website-remote-approvers.ts').RemoteApproversOptions['onRemoteEvidence'];
  requireRemoteScopes?(scopes:import('../shared/website-remote-approvers.ts').RemoteApproverScope[]):Promise<void>;
  remoteTemplate?(scope:import('../shared/website-remote-approvers.ts').RemoteApproverScope):Promise<import('../shared/website-remote-disclosure.ts').RemoteDisclosureTemplate>;
  refreshRemoteSources?():Promise<void>;
  authority?(): string;
  revisionEpoch?(): number;
  preview(descriptor: WebsiteCommandDescriptor): Promise<WebsiteRequestPreviewContent>;
  check(descriptor: WebsiteCommandDescriptor, binding: Record<string, unknown>): Promise<void>;
  dispatch(execution: WebsiteRequestExecution): Promise<WebsiteRequestRun>;
  lookup(execution: WebsiteRequestExecution): Promise<WebsiteRequestRun | null>;
  cancel(run: WebsiteRequestRun): Promise<void>;
  barrier?(): void;
  withActivity?<T>(work: () => Promise<T>): Promise<T>;
  fetch?: typeof fetch;
  now?: () => number;
}
type Decision = { choice: 'approve' | 'reject'; previewDigest: string; at: string };
type Intent = { requestId: string; claim: WebsiteCommandClaim; stage: 'claim' | 'dispatch' };
export type SavedWebsiteRequest = {
  version: 1; envelope: WebsiteCommandEnvelope; envelopeDigest: string; identity: WebsiteRequestIdentity;
  remote: WebsiteCommandState; phase: WebsiteCommandPhase; outcome: WebsiteCommandOutcome | null;
  preview: WebsiteRequestPreview | null; decision: Decision | null; intent: Intent | null;
  run: WebsiteRequestRun | null; runReference: string | null; pendingEvent: WebsiteCommandEvent | null;
  restored: boolean; cancellationRequested: boolean; updatedAt: string;
};
type SavedGrant = {
  version: 1; identity: WebsiteRequestIdentity; companyId: string; enrollment: WebsiteCommandEnrollment;
  grant: WebsiteCommandGrant | null; enabled: boolean; cursor: number; revoked: boolean;
};
const failure = (message: string, status = 409): never => { throw Object.assign(new Error(message), { status }); };
const recovery = (): never => failure('Website request history needs recovery. No work was started.', 503);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> => object(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const same = (a: unknown, b: unknown) => canonicalWebsiteCommand(a) === canonicalWebsiteCommand(b);
export const websiteRequestDigest = (value: unknown) => createHash('sha256').update(canonicalWebsiteCommand(value)).digest('hex');
const validIdentity = (v: unknown): v is WebsiteRequestIdentity => exact(v, ['workspaceId','workerProfileKey']) && typeof v.workspaceId === 'string' && commandUuid.test(v.workspaceId) && (v.workerProfileKey === null || typeof v.workerProfileKey === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v.workerProfileKey));
const iso = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v));
const terminal = (phase: WebsiteCommandPhase) => ['completed','needs-review','partial','failed','rejected','cancelled','expired','stale'].includes(phase);
const runPhases = ['running','completed','needs-review','partial','failed','interrupted','cancelled'];
const outcomes = ['prepared','review-required','partial-results','execution-failed','execution-interrupted','declined','cancelled','expired','binding-changed'];
const validRun = (v: unknown): v is WebsiteRequestRun => exact(v, ['id','phase','outcome']) && typeof v.id === 'string' && /^[A-Za-z0-9:_-]{1,180}$/.test(v.id) && runPhases.includes(String(v.phase)) && (v.outcome === null || outcomes.includes(String(v.outcome)));
function validContent(value: unknown): value is WebsiteRequestPreviewContent {
  if (!exact(value, ['title','details','binding']) || !commandLabel(value.title, 160) || !Array.isArray(value.details) || value.details.length > 64 || !object(value.binding)) return false;
  if (!value.details.every(v => exact(v, ['label','value']) && commandLabel(v.label, 160) && typeof v.value === 'string' && v.value.length <= 8192)) return false;
  try { return Buffer.byteLength(JSON.stringify(value)) <= 64_000 && Buffer.byteLength(JSON.stringify(value.binding)) <= 32_000; } catch { return false; }
}
function previewDigest(envelopeDigest: string, identity: WebsiteRequestIdentity, content: WebsiteRequestPreviewContent) { return websiteRequestDigest({ envelopeDigest, identity, content }); }
export function validateSavedWebsiteRequest(id: string, value: unknown): SavedWebsiteRequest {
  if (!exact(value, ['version','envelope','envelopeDigest','identity','remote','phase','outcome','preview','decision','intent','run','runReference','pendingEvent','restored','cancellationRequested','updatedAt']) || value.version !== 1 || !isWebsiteCommandEnvelope(value.envelope) || id !== `website-request:${value.envelope.id}` || !validIdentity(value.identity) || value.identity.workspaceId !== value.envelope.workspaceId || value.envelopeDigest !== websiteRequestDigest(value.envelope) || !isWebsiteCommandState(value.remote) || !same(value.remote.envelope, value.envelope) || typeof value.restored !== 'boolean' || typeof value.cancellationRequested !== 'boolean' || !iso(value.updatedAt)) return recovery();
  if (!['queued','delivered','accepted','running','completed','needs-review','partial','failed','interrupted','rejected','cancelled','expired','stale'].includes(String(value.phase)) || !(value.outcome === null || outcomes.includes(String(value.outcome)))) return recovery();
  if (value.preview !== null) {
    const p = value.preview;
    if (!exact(p, ['title','details','binding','digest','createdAt']) || !iso(p.createdAt)) return recovery();
    const content = { title: p.title, details: p.details, binding: p.binding };
    if (!validContent(content) || p.digest !== previewDigest(String(value.envelopeDigest), value.identity, content)) return recovery();
  }
  if (value.decision !== null && (!exact(value.decision, ['choice','previewDigest','at']) || !['approve','reject'].includes(String(value.decision.choice)) || !iso(value.decision.at) || !object(value.preview) || value.decision.previewDigest !== value.preview.digest)) return recovery();
  if (value.intent !== null && (!exact(value.intent, ['requestId','claim','stage']) || value.intent.requestId !== value.envelope.id || !isWebsiteCommandClaim(value.intent.claim) || !same(value.intent.claim.envelope, value.envelope) || !['claim','dispatch'].includes(String(value.intent.stage)) || !object(value.decision) || value.decision.choice !== 'approve' || value.intent.claim.previewDigest !== value.decision.previewDigest)) return recovery();
  if (value.run !== null && (!validRun(value.run) || value.preview === null || value.decision === null)) return recovery();
  if (!(value.runReference === null || typeof value.runReference === 'string' && commandUuid.test(value.runReference)) || (value.run !== null && value.runReference === null)) return recovery();
  if (value.pendingEvent !== null && (!isWebsiteCommandEvent(value.pendingEvent) || value.pendingEvent.requestId !== value.envelope.id || value.pendingEvent.grantId !== value.envelope.grantId || value.pendingEvent.generation !== value.envelope.generation)) return recovery();
  if (value.restored && (value.intent !== null || value.pendingEvent !== null || ['queued','delivered','accepted','running'].includes(String(value.phase)))) return recovery();
  return structuredClone(value) as SavedWebsiteRequest;
}
/** Backup retains evidence but a restored record can never grant execution authority. */
export function restoreWebsiteRequest(id: string, value: unknown, restoredAt: string): SavedWebsiteRequest {
  if (!iso(restoredAt)) return recovery();
  const saved = validateSavedWebsiteRequest(id, value);
  return { ...saved, restored: true, intent: null, pendingEvent: null, phase: terminal(saved.phase) ? saved.phase : 'interrupted', outcome: terminal(saved.phase) ? saved.outcome : 'execution-interrupted', updatedAt: restoredAt };
}
function validGrant(value: unknown): value is SavedGrant {
  return exact(value, ['version','identity','companyId','enrollment','grant','enabled','cursor','revoked']) && value.version === 1 && validIdentity(value.identity) && commandLabel(value.companyId,100) && isWebsiteCommandEnrollment(value.enrollment) && value.identity.workspaceId === value.enrollment.workspaceId && (value.grant === null || isWebsiteCommandGrant(value.grant) && grantMatches(value as unknown as SavedGrant, value.grant)) && typeof value.enabled === 'boolean' && typeof value.revoked === 'boolean' && Number.isSafeInteger(value.cursor) && Number(value.cursor) >= 0;
}
function grantMatches(saved: SavedGrant, grant: WebsiteCommandGrant): boolean {
  const { commandToken: _token, ...enrollment } = saved.enrollment;
  const { companyId, enrolledAt: _date, revokedAt: _revoked, ...identity } = grant;
  return companyId === saved.companyId && same(enrollment, identity);
}

export function createWebsiteRequests(options: WebsiteRequestsOptions) {
  const path = join(options.directory, 'website-requests', 'grant.json');
  const transport = createWebsiteRequestsTransport(options.fetch);
  const now = options.now ?? Date.now;
  const timestamp = () => new Date(now()).toISOString();
  let busy = false, recovered = false, stopped = false, timer: ReturnType<typeof setInterval> | undefined;
  let error: string | null = null;
  const idle = new Set<()=>void>();
  async function exclusive<T>(work: () => Promise<T>): Promise<T> {
    if(options.withActivity) return options.withActivity(()=>exclusiveInternal(work));
    return exclusiveInternal(work);
  }
  async function exclusiveInternal<T>(work: () => Promise<T>) {
    if (busy) return failure('Another website request update is running. Try again shortly.');
    busy = true;
    try { options.barrier?.(); const result = await work(); error = null; return result; }
    catch (cause) { error = cause instanceof WebsiteRequestsTransportError ? cause.message : 'This request could not be updated. Review its current status and try again.'; throw cause; }
    finally { busy = false; for(const resolve of idle)resolve(); idle.clear(); }
  }
  async function readGrant() {
    const value = await readPrivateJson(path, 64_000);
    if(isRemoteModeMarker(value))return null;
    if(await readPrivateJson(join(options.directory,'website-requests',REMOTE_STATE_FILE),2_000_000)!==undefined)return recovery();
    if (value === undefined) return null;
    if (!validGrant(value)) return recovery(); return value;
  }
  async function saveGrant(value: SavedGrant) { if (!validGrant(value)) return recovery(); await writePrivateJson(path, value); }
  async function ensureRemoteMarker(marker:RemoteModeMarker,previous:RemoteModeMarker|null=null) {
    if(!isRemoteModeMarker(marker))return recovery();
    const prior=await readPrivateJson(path,64_000);
    if(isRemoteModeMarker(prior)) {
      if(same(prior,marker))return;
      if(marker.generation!==prior.generation+1||!previous||!same(prior,previous))return recovery();
    } else if(prior!==undefined) {
      if(!validGrant(prior)||prior.enabled||!prior.revoked||marker.generation!==prior.enrollment.generation+1)return recovery();
    } else if(marker.generation!==1)return recovery();
    await writePrivateJson(path,marker);
  }
  const remote = createWebsiteRemoteApprovers({
    directory:options.directory,officeLink:options.officeLink,identity:options.identity,getCatalog:options.getCatalog,
    authority:()=>options.authority?.()??failure('Remote enrollment is not configured.',503),
    revisionEpoch:()=>options.revisionEpoch?.()??0,requireRemoteScopes:options.requireRemoteScopes,onRemoteEvidence:options.onRemoteEvidence,barrier:options.barrier,fetch:options.fetch,now:options.now,
    exclusive:async(work,wait=false)=>{
      if(wait)while(busy)await new Promise<void>(resolve=>idle.add(resolve));
      return exclusive(work);
    },
    prepareMarker:async persist=>{
      const prior=await readPrivateJson(path,64_000);
      if(prior!==undefined&&!isRemoteModeMarker(prior)&&!validGrant(prior))return recovery();
      if(validGrant(prior)&&prior.enabled)return failure('Disable local-review website requests before enabling remote enrollment.');
      if(validGrant(prior)&&!prior.revoked)await revoke(prior);
      if(isRemoteModeMarker(prior)&&await readPrivateJson(join(options.directory,'website-requests',REMOTE_STATE_FILE),2_000_000)===undefined)return recovery();
      const generation=isRemoteModeMarker(prior)?prior.generation+1:validGrant(prior)?prior.enrollment.generation+1:1;
      await ensureRemoteMarker(await persist(generation),isRemoteModeMarker(prior)?prior:null);
    },
    ensureMarker:ensureRemoteMarker,
  });
  const remoteWork=createWebsiteRemoteWork({...options,authority:remote.workAuthority,exclusive:async(work,wait=false)=>{if(wait)while(busy)await new Promise<void>(resolve=>idle.add(resolve));return exclusive(work);}});
  async function syncRemote(){return exclusive(async()=>{await remote.syncWithinActivity();await remoteWork.syncWithinActivity();});}
  async function remoteMode(){return isRemoteModeMarker(await readPrivateJson(path,64_000)) || await readPrivateJson(join(options.directory,'website-requests',REMOTE_STATE_FILE),2_000_000)!==undefined;}
  function get(id: string) {
    if (!commandUuid.test(id)) return failure('Invalid website request.',400);
    const row = options.db.get<SavedWebsiteRequest>(WEBSITE_REQUEST_KIND, `website-request:${id}`);
    if (!row) return failure('This website request was not found.',404);
    validateSavedWebsiteRequest(row.id,row.value); return row;
  }
  function put(row: WorkflowRecord<SavedWebsiteRequest>, changes: Partial<SavedWebsiteRequest>) {
    const next = { ...row.value, ...changes, updatedAt: timestamp() }; validateSavedWebsiteRequest(row.id,next);
    return options.db.update<SavedWebsiteRequest>(WEBSITE_REQUEST_KIND,row.id,row.revision,()=>next);
  }
  function* all(): Generator<WorkflowRecord<SavedWebsiteRequest>> {
    let cursor: number | undefined;
    do {
      // Keep only one bounded page of decrypted previews alive. Updating a row
      // does not change its insertion cursor, so receipt writes cannot skip or
      // repeat older requests while this iterator is suspended at an await.
      const page = options.db.page<SavedWebsiteRequest>(WEBSITE_REQUEST_KIND,{before:cursor,limit:200});
      for (const row of page.records) { validateSavedWebsiteRequest(row.id,row.value); yield row; }
      cursor = page.next ?? undefined;
    } while(cursor);
  }
  function execution(saved: SavedWebsiteRequest): WebsiteRequestExecution {
    if (!saved.preview) return recovery();
    return { descriptor: structuredClone(saved.envelope.descriptor), requestId:saved.envelope.id,binding:structuredClone(saved.preview.binding) };
  }
  async function current(saved: SavedGrant) {
    options.barrier?.();
    if (stopped || !saved.enabled || saved.revoked || !saved.grant || saved.grant.revokedAt) return failure('Requests for this workspace are disabled.');
    if (!same(options.identity(),saved.identity)) return failure('The private workspace or worker changed. Enable requests again for this workspace.');
    const link = await options.officeLink.credentials();
    if (!link || link.installationId !== saved.enrollment.installationId || link.companyId !== saved.companyId) return failure('The website link changed. Enable requests again for this workspace.');
    const latest = await readGrant();
    if (!latest || !latest.enabled || latest.revoked || !same(latest.enrollment,saved.enrollment)) return failure('Website request permission changed.');
    options.barrier?.(); return link;
  }
  async function check(saved: SavedGrant, row: WorkflowRecord<SavedWebsiteRequest>) {
    await current(saved);
    const value = row.value;
    if (value.restored || value.envelope.grantId !== saved.enrollment.grantId || value.envelope.generation !== saved.enrollment.generation || !same(value.identity,saved.identity)) return failure('This request belongs to an inactive workspace permission.');
    if (value.cancellationRequested || value.remote.cancellationRequested || value.remote.phase === 'cancelled') return failure('This request was cancelled.');
    if (Date.parse(value.envelope.expiresAt) <= now()) return failure('This request has expired.');
    const catalog = await options.getCatalog();
    if (!catalog.some(d=>same(d,value.envelope.descriptor))) return failure('The work plan changed. Publish the current work before requesting it again.');
    if (value.preview) await options.check(value.envelope.descriptor, structuredClone(value.preview.binding));
    await current(saved);
  }
  function target(saved: SavedGrant, state: WebsiteCommandState) {
    const e=state.envelope;
    if (e.installationId!==saved.enrollment.installationId || e.companyId!==saved.companyId || e.workspaceId!==saved.identity.workspaceId || e.grantId!==saved.enrollment.grantId || e.generation!==saved.enrollment.generation || !saved.enrollment.descriptors.some(d=>same(d,e.descriptor))) return failure('The website returned a request for another workspace.',502);
  }
  function ingest(saved: SavedGrant,state: WebsiteCommandState) {
    target(saved,state);
    const existing=options.db.get<SavedWebsiteRequest>(WEBSITE_REQUEST_KIND,`website-request:${state.envelope.id}`);
    if (!existing) {
      if (options.db.count(WEBSITE_REQUEST_KIND)>=5000) return failure('Website request history needs assisted archival before accepting more work.');
      const value:SavedWebsiteRequest={version:1,envelope:state.envelope,envelopeDigest:websiteRequestDigest(state.envelope),identity:saved.identity,remote:state,phase:state.phase==='queued'?'delivered':state.phase,outcome:state.outcome,preview:null,decision:null,intent:null,run:null,runReference:null,pendingEvent:null,restored:false,cancellationRequested:state.cancellationRequested,updatedAt:timestamp()};
      // A previously claimed request without local evidence must not be adopted as approval.
      if (['accepted','running'].includes(value.phase)) { value.phase='interrupted'; value.outcome='execution-interrupted'; }
      validateSavedWebsiteRequest(`website-request:${state.envelope.id}`,value);
      return options.db.create(WEBSITE_REQUEST_KIND,`website-request:${state.envelope.id}`,value,5000);
    }
    validateSavedWebsiteRequest(existing.id,existing.value);
    if (!same(existing.value.envelope,state.envelope)) return failure('A conflicting website request needs recovery.',503);
    if (state.revision<existing.value.remote.revision) return existing;
    if (state.revision===existing.value.remote.revision && !same(state,existing.value.remote)) return failure('A conflicting website request receipt needs recovery.',503);
    if (same(state,existing.value.remote)) return existing;
    let phase=existing.value.phase, outcome=existing.value.outcome;
    if (!existing.value.run && (state.phase==='cancelled' || state.phase==='expired' || state.phase==='stale')) { phase=state.phase; outcome=state.outcome; }
    return put(existing,{remote:state,phase,outcome,cancellationRequested:existing.value.cancellationRequested||state.cancellationRequested});
  }
  async function flush(saved:SavedGrant,row:WorkflowRecord<SavedWebsiteRequest>) {
    if(row.value.restored) return row;
    const v=row.value;
    if(!v.pendingEvent && (v.phase!==v.remote.phase || v.outcome!==v.remote.outcome || v.runReference!==v.remote.runReference)) {
      // 'accepted' is minted only by an online claim, never by an event.
      if(v.phase==='accepted') return row;
      // A fast executor may already be terminal. Preserve the protocol's durable
      // accepted -> running -> outcome evidence without starting work again.
      const enteringRun = v.remote.phase==='accepted' && v.run!==null;
      const event:WebsiteCommandEvent={grantId:v.envelope.grantId,generation:v.envelope.generation,requestId:v.envelope.id,eventId:randomUUID(),expectedRevision:v.remote.revision,phase:enteringRun?'running':v.phase,outcome:enteringRun?null:v.outcome,runReference:v.runReference};
      row=put(row,{pendingEvent:event});
    }
    if(!row.value.pendingEvent) return row;
    const event=row.value.pendingEvent;
    let state:WebsiteCommandState;
    try {state=await transport.post('commands/ack',saved.enrollment.commandToken,event,v=>isWebsiteCommandState(v)?v:failure('Invalid website event receipt.',502));}
    catch(cause) {
      if(cause instanceof WebsiteRequestsTransportError&&cause.status===409) return put(row,{pendingEvent:null});
      throw cause;
    }
    target(saved,state);
    if(!same(state.envelope,row.value.envelope) || state.revision!==event.expectedRevision+1 || state.phase!==event.phase || state.outcome!==event.outcome || state.runReference!==event.runReference) return failure('The website returned an inconsistent delivery receipt.',502);
    // An exact event retry may be older than a cancellation observed through polling.
    const remote=state.revision>=row.value.remote.revision?state:row.value.remote;
    row=put(row,{remote,pendingEvent:null});
    if(state.phase==='running' && row.value.phase!=='running' && row.value.phase!=='accepted') return flush(saved,row);
    return row;
  }
  async function reconcile(row:WorkflowRecord<SavedWebsiteRequest>) {
    if(row.value.restored || !row.value.preview || (!row.value.intent && !row.value.run)) return row;
    const found=await options.lookup(execution(row.value));
    if(found) {
      if(!validRun(found) || row.value.run && row.value.run.id!==found.id) return recovery();
      if(!same(found,row.value.run) || row.value.phase!==found.phase || row.value.intent) row=put(row,{run:found,runReference:row.value.runReference??randomUUID(),intent:null,phase:found.phase,outcome:found.outcome});
    }
    return row;
  }
  async function recoverInternal() {
    if(recovered) return;
    for(let row of all()) {
      if(row.value.restored) continue;
      row=await reconcile(row);
      if(row.value.intent && !row.value.run) put(row,{intent:null,phase:'interrupted',outcome:'execution-interrupted'});
    }
    recovered=true;
  }
  async function revoke(saved:SavedGrant) {
    try {
      await transport.post('command-grants',saved.enrollment.commandToken,{grantId:saved.enrollment.grantId,generation:saved.enrollment.generation},v=>exact(v,['ok'])&&v.ok===true?v:failure('Invalid revocation receipt.',502),'DELETE');
    } catch(cause) { if(!(cause instanceof WebsiteRequestsTransportError) || ![401,403].includes(cause.status)) throw cause; }
    await saveGrant({...saved,enabled:false,revoked:true});
  }
  async function disableInternal(saved:SavedGrant) {
    // Local revocation wins even while offline. Keep the credential solely to retry upstream revocation.
    saved={...saved,enabled:false}; await saveGrant(saved);
    for(let row of all()) if(row.value.envelope.grantId===saved.enrollment.grantId&&!row.value.restored) {
      row=await reconcile(row);
      if(row.value.run?.phase==='running') {row=put(row,{cancellationRequested:true});await options.cancel(row.value.run!);}
      else if(!terminal(row.value.phase)) put(row,{intent:null,phase:'cancelled',outcome:'cancelled'});
    }
    if(!saved.revoked)await revoke(saved);
  }
  async function enroll(input:{descriptorIds:string[];label:string}) { return exclusive(async()=>{
    if(await remoteMode())return failure('This workspace requires protocol 2. Legacy enrollment cannot replace its permission.');
    await recoverInternal();
    if(!exact(input,['descriptorIds','label']) || !commandLabel(input.label) || !Array.isArray(input.descriptorIds) || input.descriptorIds.length<1 || input.descriptorIds.length>16 || new Set(input.descriptorIds).size!==input.descriptorIds.length || !input.descriptorIds.every(id=>typeof id==='string'&&commandUuid.test(id))) return failure('Choose the work to publish and name this private workspace.',400);
    const link=await options.officeLink.credentials(); if(!link) return failure('Link this computer to a website account first.');
    const identity=options.identity(); if(!validIdentity(identity)) return recovery();
    const catalog=await options.getCatalog();
    const descriptors=input.descriptorIds.map(id=>catalog.find(d=>d.id===id)??failure('The selected work is no longer available.'));
    if(!descriptors.every(isWebsiteCommandDescriptor)) return recovery();
    let saved=await readGrant();
    if(saved?.enabled&&saved.grant) return failure('Disable the current workspace permission before publishing a new catalog.');
    if(saved&&!saved.enabled&&!saved.revoked) await revoke(saved);
    if(saved?.enabled&&!saved.grant) {
      if(saved.enrollment.installationId!==link.installationId || saved.companyId!==link.companyId || !same(saved.identity,identity) || saved.enrollment.workspaceLabel!==input.label || !same(saved.enrollment.descriptors,descriptors)) return failure('Retry the original enrollment, or disable it before publishing different work.');
    } else {
      saved={version:1,identity,companyId:link.companyId,enrollment:{protocol:1,grantId:randomUUID(),generation:(saved?.enrollment.generation??0)+1,installationId:link.installationId,workspaceId:identity.workspaceId,workspaceLabel:input.label,descriptors,commandToken:randomBytes(32).toString('hex')},grant:null,enabled:true,cursor:0,revoked:false};
      await saveGrant(saved);
    }
    const grant=await transport.post('command-grants',link.token,saved.enrollment,v=>isWebsiteCommandGrant(v)?v:failure('Invalid workspace permission receipt.',502));
    if(!grantMatches(saved,grant)||grant.revokedAt) return failure('The website returned a different workspace permission.',502);
    const freshLink=await options.officeLink.credentials();
    if(!freshLink||freshLink.installationId!==link.installationId||freshLink.companyId!==link.companyId||!same(identity,options.identity())) { await saveGrant({...saved,enabled:false,grant}); return failure('The workspace link changed during enrollment.'); }
    await saveGrant({...saved,grant});
    return status();
  }); }
  async function syncInternal() {
    await recoverInternal(); let saved=await readGrant(); if(!saved)return;
    if(!saved.enabled){if(!saved.revoked)await revoke(saved);return;}
    if(!saved.grant)return;
    const link=await options.officeLink.credentials();
    if(!same(saved.identity,options.identity())||!link||link.installationId!==saved.enrollment.installationId||link.companyId!==saved.companyId){await disableInternal(saved);return;}
    await current(saved);
    // Reconcile exact pending receipts before consuming newer remote revisions.
    for(let row of all()) if(row.value.envelope.grantId===saved.enrollment.grantId&&!row.value.restored) {
      row=await reconcile(row);
      if(row.value.pendingEvent) await flush(saved,row);
    }
    for(let page=0;page<8;page++) {
      const result:WebsiteCommandPollResult=await transport.post('commands/poll',saved.enrollment.commandToken,{grantId:saved.enrollment.grantId,generation:saved.enrollment.generation,cursor:saved.cursor},v=>isWebsiteCommandPollResult(v)?v:failure('Invalid website request page.',502));
      if(!grantMatches(saved,result.grant)||result.cursor<saved.cursor||result.requests.some(r=>r.sequence>result.cursor)||result.hasMore&&result.cursor===saved.cursor) return failure('The website returned an inconsistent request page.',502);
      if(result.grant.revokedAt){await disableInternal({...saved,grant:result.grant});return;}
      await current(saved);
      for(const state of result.requests) ingest(saved,state);
      saved={...saved,cursor:result.cursor}; await saveGrant(saved);
      if(!result.hasMore)break;
    }
    for(let row of all()) if(row.value.envelope.grantId===saved.enrollment.grantId&&!row.value.restored) {
      row=await reconcile(row);
      if(row.value.remote.cancellationRequested) {
        if(row.value.run?.phase==='running') {await options.cancel(row.value.run);row=await reconcile(row);}
        else if(!row.value.run&&!terminal(row.value.phase)) row=put(row,{intent:null,phase:'cancelled',outcome:'cancelled'});
      }
      if(!row.value.run&&!terminal(row.value.phase)&&Date.parse(row.value.envelope.expiresAt)<=now()) row=put(row,{intent:null,phase:'expired',outcome:'expired'});
      await flush(saved,row);
    }
  }
  async function safeSync() {
    try {await syncInternal();}
    catch(cause) {
      if(cause instanceof WebsiteRequestsTransportError&&[401,403].includes(cause.status)){const saved=await readGrant();if(saved)await disableInternal({...saved,revoked:true});}
      throw cause;
    }
  }
  async function preview(id:string,expectedRevision:number) { return exclusive(async()=>{
    await recoverInternal(); let row=get(id); if(row.revision!==expectedRevision)return failure('This request changed. Refresh it before reviewing.');
    if(row.value.intent) {row=await reconcile(row);if(row.value.intent)return failure('An approval is awaiting confirmation. Retry that decision or cancel it before reviewing again.');}
    if(row.value.run||terminal(row.value.phase))return failure('This request already has a final decision or execution.');
    const saved=await readGrant();if(!saved)return failure('Enable requests for this workspace first.');
    await check(saved,row);
    const content=await options.preview(structuredClone(row.value.envelope.descriptor));if(!validContent(content))return recovery();
    await current(saved); options.barrier?.();
    const p:WebsiteRequestPreview={...structuredClone(content),digest:previewDigest(row.value.envelopeDigest,row.value.identity,content),createdAt:timestamp()};
    row=put(row,{preview:p,decision:null,intent:null});return row;
  }); }
  async function decide(id:string,input:{expectedRevision:number;previewDigest:string;decision:'approve'|'reject'}) {return exclusive(async()=>{
    await recoverInternal();
    if(!exact(input,['expectedRevision','previewDigest','decision'])||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<1||!commandDigest.test(input.previewDigest)||!['approve','reject'].includes(input.decision))return failure('Review the current request before deciding.',400);
    let row=get(id);if(row.revision!==input.expectedRevision)return failure('This request changed. Refresh it before deciding.');
    if(!row.value.preview||row.value.preview.digest!==input.previewDigest||row.value.run||terminal(row.value.phase))return failure('Review the current request before deciding.');
    const saved=await readGrant();if(!saved)return failure('Enable requests for this workspace first.');
    await check(saved,row);
    if(input.decision==='reject') {
      const cancelApproval=!!row.value.intent||row.value.decision?.choice==='approve'||row.value.remote.phase==='accepted';
      row=put(row,{decision:{choice:'reject',previewDigest:input.previewDigest,at:timestamp()},intent:null,phase:cancelApproval?'cancelled':'rejected',outcome:cancelApproval?'cancelled':'declined',cancellationRequested:cancelApproval});await flush(saved,row);return get(id);
    }
    if(row.value.pendingEvent)row=await flush(saved,row);
    const found=await options.lookup(execution(row.value));
    if(found) {if(!validRun(found))return recovery();return put(row,{run:found,runReference:row.value.runReference??randomUUID(),phase:found.phase,outcome:found.outcome,intent:null});}
    const claim:WebsiteCommandClaim=row.value.intent?.claim??{grantId:row.value.envelope.grantId,generation:row.value.envelope.generation,requestId:id,expectedRevision:row.value.remote.revision,envelope:row.value.envelope,previewDigest:input.previewDigest,claimId:randomUUID()};
    if(claim.previewDigest!==input.previewDigest)return failure('The approval changed. Review this request again.');
    row=put(row,{decision:{choice:'approve',previewDigest:input.previewDigest,at:timestamp()},intent:{requestId:id,claim,stage:'claim'}});
    const started=now();
    const permission=await transport.post('commands/claim',saved.enrollment.commandToken,claim,v=>isWebsiteCommandClaimResult(v)?v:failure('Invalid website dispatch permission.',502));
    target(saved,permission.request);
    const duration=Date.parse(permission.validUntil)-Date.parse(permission.serverTime);
    if(!same(permission.request.envelope,row.value.envelope)||permission.claimId!==claim.claimId||permission.previewDigest!==input.previewDigest||permission.request.phase!=='accepted'||permission.request.cancellationRequested||permission.request.revision!==claim.expectedRevision+1||duration<=0||duration>60_000) return failure('The website returned an inconsistent dispatch permission.',502);
    if(now()-started>=duration||Date.parse(permission.validUntil)<=now()) {row=put(row,{remote:permission.request,intent:null,phase:'interrupted',outcome:'execution-interrupted',runReference:null});await flush(saved,row).catch(()=>{});return failure('Dispatch permission is no longer current. Review this request again.');}
    row=put(row,{remote:permission.request,phase:'accepted',outcome:null,intent:{requestId:id,claim,stage:'dispatch'},runReference:null});
    try {
      await check(saved,row);
      if(now()-started>=duration||Date.parse(permission.validUntil)<=now())return failure('Dispatch permission expired before work could start.');
    } catch(cause) {row=put(row,{intent:null,phase:'interrupted',outcome:'execution-interrupted',runReference:null});await flush(saved,row).catch(()=>{});throw cause;}
    // Persisted intent plus the existing executor's exact request key are the crash boundary.
    let run:WebsiteRequestRun;
    try{run=await options.dispatch(execution(row.value));}
    catch(cause){const reconciled=await reconcile(row);if(reconciled.value.run){await flush(saved,reconciled);return get(id);}put(row,{phase:'interrupted',outcome:'execution-interrupted',intent:null});throw cause;}
    if(!validRun(run))return recovery();
    row=put(row,{run,runReference:row.value.runReference??randomUUID(),phase:run.phase,outcome:run.outcome,intent:null});
    await flush(saved,row);return get(id);
  });}
  async function cancel(id:string,expectedRevision:number){return exclusive(async()=>{
    await recoverInternal();let row=get(id);if(row.revision!==expectedRevision)return failure('This request changed. Refresh it before cancelling.');
    if(row.value.restored)return failure('Restored request history cannot control work.');
    row=put(row,{cancellationRequested:true});
    row=await reconcile(row);
    if(row.value.run?.phase==='running'){await options.cancel(row.value.run);row=await reconcile(row);}
    else if(!row.value.run&&!terminal(row.value.phase))row=put(row,{intent:null,phase:'cancelled',outcome:'cancelled'});
    const saved=await readGrant();if(saved?.enabled&&saved.enrollment.grantId===row.value.envelope.grantId)await flush(saved,row);return get(id);
  });}
  async function status():Promise<WebsiteRequestsStatus>{if(await remoteMode()){const state=await remote.status();return {remoteMode:true,enabled:false,pending:false,linked:state.linked,workspaceId:state.workspaceId,workspaceLabel:state.workspaceLabel,grant:null,error:state.error,busy,catalog:await options.getCatalog(),publishedDescriptors:[]};}const saved=await readGrant();const link=await options.officeLink.credentials();return {enabled:!!saved?.enabled&&!saved.revoked, pending:!!saved?.enabled&&!saved.grant, linked:!!link, workspaceId:options.identity().workspaceId, workspaceLabel:saved?.enrollment.workspaceLabel??null, grant:saved?.grant??null, error, busy, catalog:await options.getCatalog(),publishedDescriptors:saved?.enrollment.descriptors??[]};}
  function list(input:{before?:number;limit?:number}={}) {const page=options.db.page<SavedWebsiteRequest>(WEBSITE_REQUEST_KIND,{before:input.before,limit:input.limit??50});for(const row of page.records)validateSavedWebsiteRequest(row.id,row.value);return {records:page.records,next:page.next};}
  return {status,list,enroll,preview,decide,cancel,remote,remoteWork:{...remoteWork,sync:syncRemote},withRemoteActivity:exclusive,
    get busy(){return busy;},
    executionBinding(requestId:string): WebsiteRequestExecution | null {
      if(!commandUuid.test(requestId))return null;
      const row=options.db.get<SavedWebsiteRequest>(WEBSITE_REQUEST_KIND,`website-request:${requestId}`);
      if(!row)return remoteWork.executionBinding(requestId);validateSavedWebsiteRequest(row.id,row.value);
      if(row.value.restored||row.value.cancellationRequested||!row.value.preview||row.value.decision?.choice!=='approve'||row.value.intent?.stage!=='dispatch'&&!row.value.run)return failure('Website execution permission is no longer active.');
      return execution(row.value);
    },
    recover:()=>exclusive(async()=>{await recoverInternal();await remoteWork.recoverWithinActivity();}),
    sync:async()=>{if(await remoteMode()){await syncRemote();return;}return exclusive(safeSync);},
    disable:async()=>{remoteWork.invalidate();if(await remoteMode()){let cause:unknown;try{await remoteWork.disable();}catch(error){cause=error;}await remote.disable();if(cause)throw cause;return status();}return exclusive(async()=>{await recoverInternal();const saved=await readGrant();if(saved)await disableInternal(saved);return status();});},
    start(){if(timer)return;stopped=false;remote.start();remoteWork.start();const tick=()=>{if(!busy)void (async()=>{if(await remoteMode())await syncRemote();else await exclusive(safeSync);})().catch(()=>{});};tick();timer=setInterval(tick,30_000);timer.unref();},
    stop(){stopped=true;remote.stop();remoteWork.stop();if(timer)clearInterval(timer);timer=undefined;transport.abort();},
  };
}
