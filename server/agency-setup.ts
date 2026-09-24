import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { AGENCY_WORKFLOWS, AGENCY_WORKFLOW_NAMES, type AgencySetupSettings, type AgencySetupState, type AgencySetupView, type AgencySetupObservations, type AgencyWorkflowId, type AgencySetupCheck } from '../shared/agency-setup.ts';
import { readPrivateJson, writePrivateJson } from './private-json.ts';
import { containsCredential } from './redact.ts';
import { isAgencyWorkflowPackId, AGENCY_WORKFLOW_PACK_NAMES } from '../shared/agency-workflow-packs.ts';
import { mailHistorySetupDetail } from '../shared/mail-ingestion.ts';

const MAX_BYTES = 900_000;
/** Reports the installed office-core and Austin bank preparation plans, which
 * accept bankBrand=ANZ only. The block lives in that plan, not in this setup
 * check; reference mapping alone does not widen it. */
export const BANK_ADAPTER_LIMIT = 'The installed preparation plan accepts ANZ exports only; it blocks other bank brands until a host adapter and source contract exist.';
const fail = (message: string, status = 400, code = 'agency_setup_invalid'): never => { throw Object.assign(new Error(message), { status, code }); };
const object = (value: unknown, keys: string[]): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) return fail('Use the supported agency settings fields. Verification and credentials cannot be entered here.');
  return value as Record<string, unknown>;
};
const clean = (value: unknown, max: number, empty = false): string => {
  if (typeof value !== 'string' || value.length > max || /[\x00-\x1f\x7f]/.test(value) || containsCredential(value) || (!empty && !value.trim())) return fail('Use plain text without credentials in agency settings.');
  return value.trim();
};
const id = (value: unknown) => { const result = clean(value, 120); if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(result)) return fail('The selected record identifier is invalid.'); return result; };
const workflowId = (value: unknown): AgencyWorkflowId => typeof value === 'string' && (AGENCY_WORKFLOWS as readonly string[]).includes(value) ? value as AgencyWorkflowId : fail('Choose a supported workflow.');
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalized = (value: string) => value.normalize('NFKC').toLocaleLowerCase('en-AU').trim();
export function defaultAgencySettings(): AgencySetupSettings {
  return { agencyName: '', workflowPackId: null, timeZone: '', gmailAccountId: null, mailScope: { historyDays: 7, includeSent: true, maxMessages: 100, attachments: 'metadata-only' }, propertyReferences: [], selectedWorkflows: [], morningReview: { localTime: '08:00', weekdays: [1, 2, 3, 4, 5], followUpAfterDays: 3 } };
}
export function validateAgencySettings(value: unknown): AgencySetupSettings {
  const input = object(value, ['agencyName', 'workflowPackId', 'timeZone', 'gmailAccountId', 'mailScope', 'propertyReferences', 'selectedWorkflows', 'morningReview']);
  if (Buffer.byteLength(JSON.stringify(input)) > MAX_BYTES) return fail('Agency setup is too large. Use at most 2,000 property references.');
  const agencyName = clean(input.agencyName, 120, true), timeZone = clean(input.timeZone, 100, true);
  if (input.workflowPackId !== null && !isAgencyWorkflowPackId(input.workflowPackId)) return fail('Choose a supported workflow pack explicitly. Imported titles cannot select the active workflow.');
  const scope = object(input.mailScope, ['historyDays', 'includeSent', 'maxMessages', 'attachments']);
  if (!Number.isSafeInteger(scope.historyDays) || Number(scope.historyDays) < 1 || Number(scope.historyDays) > 90 || typeof scope.includeSent !== 'boolean' || !Number.isSafeInteger(scope.maxMessages) || Number(scope.maxMessages) < 1 || Number(scope.maxMessages) > 500 || scope.attachments !== 'metadata-only') return fail('Choose 1–90 days and 1–500 messages. Attachments are metadata-only for this source scope.');
  if (timeZone) { try { if (timeZone !== 'UTC' && !timeZone.includes('/')) throw new Error(); new Intl.DateTimeFormat('en', { timeZone }).format(0); } catch { return fail('Choose a valid office timezone, such as Australia/Brisbane.'); } }
  if (!Array.isArray(input.propertyReferences) || input.propertyReferences.length > 2000) return fail('Use at most 2,000 property references.');
  const propertyIds = new Set<string>(), references = new Set<string>();
  const propertyReferences = input.propertyReferences.map(raw => {
    const row = object(raw, ['propertyId', 'reference', 'aliases']), propertyId = id(row.propertyId), reference = clean(row.reference, 100);
    if (/^[\s\uFEFF]*[=+@-]/u.test(reference) || propertyIds.has(propertyId) || references.has(normalized(reference))) return fail('Use one unique plain reference per property. Spreadsheet formulas are not references.');
    propertyIds.add(propertyId); references.add(normalized(reference));
    if (!Array.isArray(row.aliases) || row.aliases.length > 20) return fail('Use at most 20 payer aliases per property.');
    const aliases = row.aliases.map(alias => clean(alias, 200));
    if (aliases.some(alias => normalized(alias).replace(/[^\p{L}\p{N}]/gu, '').length < 3) || new Set(aliases.map(normalized)).size !== aliases.length) return fail('Use distinct payer aliases with at least three letters or digits.');
    return { propertyId, reference, aliases };
  });
  if (!Array.isArray(input.selectedWorkflows)) return fail('Choose the workflows to configure.');
  const selectedWorkflows = input.selectedWorkflows.map(workflowId);
  if (new Set(selectedWorkflows).size !== selectedWorkflows.length) return fail('Choose each workflow once.');
  const morning = object(input.morningReview, ['localTime', 'weekdays', 'followUpAfterDays']);
  if (typeof morning.localTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(morning.localTime) || !Array.isArray(morning.weekdays) || !morning.weekdays.length || morning.weekdays.some(day => !Number.isInteger(day) || Number(day) < 0 || Number(day) > 6) || new Set(morning.weekdays).size !== morning.weekdays.length || !Number.isSafeInteger(morning.followUpAfterDays) || Number(morning.followUpAfterDays) < 1 || Number(morning.followUpAfterDays) > 90) return fail('Choose a local morning time, distinct weekdays and a follow-up interval from 1 to 90 calendar days.');
  return { agencyName, workflowPackId: input.workflowPackId, timeZone, gmailAccountId: input.gmailAccountId === null ? null : id(input.gmailAccountId), mailScope: { historyDays: Number(scope.historyDays), includeSent: scope.includeSent, maxMessages: Number(scope.maxMessages), attachments: 'metadata-only' }, propertyReferences, selectedWorkflows: [...selectedWorkflows].sort(), morningReview: { localTime: morning.localTime, weekdays: [...morning.weekdays as number[]].sort(), followUpAfterDays: Number(morning.followUpAfterDays) } };
}
export interface AgencySetupOptions {
  directory: string; workspaceId: string; actorId: () => string; now?: () => number;
  /** Existing state only. Do not connect an account, call a model or refresh a provider here. */
  observe?: (settings: AgencySetupSettings) => Promise<AgencySetupObservations>;
  /** Optional explicit bounded check, always bound to the customer's saved selection. */
  checkGmail?: (accountId: string, settingsRevision: number) => Promise<void>;
  /** The selected account was just verified for this saved revision. The host
   * starts bounded history acquisition here. It must return promptly, it grants
   * no authority, and a failure never changes the verification result. */
  onGmailVerified?: (event: { accountId: string; settingsRevision: number; historyDays: number }) => void | Promise<void>;
}
export function createAgencySetupService(options: AgencySetupOptions) {
  const path = join(options.directory, 'agency-setup.json'), now = options.now ?? Date.now;
  let pending: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => { const next = pending.then(work, work); pending = next.catch(() => {}); return next; };
  const initial = (): AgencySetupState => ({ version: 1, workspaceId: options.workspaceId, revision: 0, updatedAt: null, settings: defaultAgencySettings(), reviews: {} });
  async function read(): Promise<AgencySetupState> {
    try {
      const saved = await readPrivateJson(path, MAX_BYTES);
      if (saved === undefined) return initial();
      const row = object(saved, ['version', 'workspaceId', 'revision', 'updatedAt', 'settings', 'reviews']);
      if (row.version !== 1 || row.workspaceId !== options.workspaceId || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1 || typeof row.updatedAt !== 'number' || !Number.isFinite(row.updatedAt)) throw new Error();
      // Legacy settings never imply Austin or the first installed pack. Expose an
      // unselected pack without rewriting original bytes; execution stays held.
      const rawSettings = row.settings && typeof row.settings === 'object' && !Array.isArray(row.settings) ? row.settings as Record<string, unknown> : {};
      const settings = validateAgencySettings(Object.hasOwn(rawSettings, 'workflowPackId') ? rawSettings : { ...rawSettings, workflowPackId: null }), reviews = object(row.reviews, [...AGENCY_WORKFLOWS]);
      for (const value of Object.values(reviews)) {
        const review = object(value, ['settingsRevision', 'evidenceDigest', 'reviewedAt', 'actorId']);
        if (review.settingsRevision !== row.revision || typeof review.evidenceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(review.evidenceDigest) || typeof review.reviewedAt !== 'number' || !Number.isFinite(review.reviewedAt)) throw new Error();
        id(review.actorId);
      }
      return { ...row, settings, reviews } as unknown as AgencySetupState;
    } catch { return fail('Saved agency setup could not be read safely. Existing settings were preserved. Restore a known-good private backup or contact support before changing setup.', 503, 'agency_setup_recovery_required'); }
  }
  async function persist(state: AgencySetupState) {
    if (Buffer.byteLength(JSON.stringify(state)) > MAX_BYTES) return fail('Agency setup has reached its storage limit. Existing settings were preserved.', 409);
    await writePrivateJson(path, state);
  }
  async function observations(settings: AgencySetupSettings): Promise<AgencySetupObservations> {
    try { return await options.observe?.(structuredClone(settings)) ?? {}; } catch { return {}; }
  }
  function project(state: AgencySetupState, observed: AgencySetupObservations): AgencySetupView {
    const settings = state.settings, time = now(), gmail = observed.gmail;
    const properties = observed.properties?.state === 'available' ? observed.properties.items : [];
    const mapped = settings.propertyReferences.length > 0 && observed.properties?.state === 'available' && settings.propertyReferences.every(rule => properties.some(property => property.id === rule.propertyId));
    // Split the freshness window off the rest so an expired check can say so.
    // Every other failing condition keeps the generic never-checked copy.
    const mailChecked = Boolean(settings.gmailAccountId && gmail?.accountId === settings.gmailAccountId && gmail.state === 'verified' && gmail.bindingRevision && gmail.accounts.some(account => account.id === settings.gmailAccountId && account.status === 'active') && gmail.checkedAt !== null && gmail.checkedAt <= time);
    const mailCheckedAgeMs = mailChecked ? time - (gmail!.checkedAt as number) : null;
    const mailVerified = mailChecked && mailCheckedAgeMs! <= 300_000;
    // Round up: flooring 5 min 0.1 s would read "verified 5 minutes ago" beside
    // "expires after five minutes", which contradicts itself.
    const mailExpiredMinutes = mailChecked && !mailVerified ? Math.ceil(mailCheckedAgeMs! / 60_000) : null;
    // History acquisition is reported beside the check it followed. It is
    // progress evidence: it never makes this check pass and never claims a
    // complete mailbox, and its absence leaves the original wording alone.
    const mailHistory = observed.mailHistory ? ` ${mailHistorySetupDetail(observed.mailHistory)}` : '';
    const workflows = AGENCY_WORKFLOWS.map(workflow => {
      const mailRequired = workflow !== 'bank-references', execution = observed.workflows?.[workflow];
      const source = execution?.sourceReceipt;
      const sourceCurrent = Boolean(source?.state === 'complete' && source.capturedAt >= (state.updatedAt ?? 0) && source.capturedAt <= time && time - source.capturedAt <= 300_000 && (!mailRequired || source.accountId === settings.gmailAccountId));
      const checks: AgencySetupCheck[] = [
        { id: 'agency', label: 'Agency and timezone', state: settings.agencyName && settings.timeZone ? 'passed' : 'needed', detail: settings.agencyName && settings.timeZone ? `${settings.agencyName} · ${settings.timeZone}` : 'Name this agency and choose the timezone its work follows.', nextAction: 'Save agency details below.', requiredForReview: true },
        { id: 'pack', label: 'Selected workflow pack', state: settings.workflowPackId ? 'passed' : 'needed', detail: settings.workflowPackId ? `${AGENCY_WORKFLOW_PACK_NAMES[settings.workflowPackId]} is explicitly selected. Its installation and plan approval are checked separately below.` : 'Select one pack for this agency. No default or first-installed plan is used.', nextAction: 'Choose a workflow pack in Agency details, import it if needed, then review its plans.', requiredForReview: true },
        ...(mailRequired ? [{ id: 'gmail', label: 'Selected private Gmail source', state: mailVerified ? 'passed' as const : gmail ? 'needed' as const : 'unknown' as const, detail: (mailVerified ? 'The host verified read access to this exact private account within the last five minutes. This is not proof of a complete workflow.' : mailExpiredMinutes !== null ? `This account was verified ${mailExpiredMinutes} minutes ago; verification expires after five minutes. Check the selected account again before approving.` : 'Choose an account and verify its current private read access. Saved credentials or a connected label alone are insufficient.') + mailHistory, nextAction: mailExpiredMinutes !== null ? 'Check selected Gmail access again.' : 'Connect Gmail, choose its account here, save, then check the selected account.', requiredForReview: true }] : []),
        ...(workflow === 'bank-references' ? [{ id: 'mapping', label: 'Property reference directory', state: mapped ? 'passed' as const : observed.properties ? 'needed' as const : 'unknown' as const, detail: `${mapped ? `${settings.propertyReferences.length} unique references match properties available to this workspace.` : 'Add a reviewed reference for each property in the selected bank scope. Unknown properties cannot be mapped.'} ${BANK_ADAPTER_LIMIT}`, nextAction: 'Add properties to Desk, then save their agreed reference numbers below.', requiredForReview: true }] : []),
        ...(workflow === 'bills-calendar' ? [{ id: 'bills', label: 'Expected bill records', state: observed.billRegister?.state === 'available' ? 'passed' as const : 'unknown' as const, detail: observed.billRegister?.state === 'available' ? `${observed.billRegister.count} saved bill records are readable. New evidence still needs property and date review.` : 'The expected-bills store has not been verified or needs recovery.', nextAction: 'Open Expected bills and resolve any recovery message.', requiredForReview: true }] : []),
        { id: 'execution', label: 'Workflow and plan readiness', state: execution?.state === 'available' && execution.bindingRevision ? 'passed' : execution ? 'needed' : 'unknown', detail: execution?.detail || 'The host has not verified an executable workflow and its required plan approval.', nextAction: 'Review the workflow plan and complete its worker or source setup.', requiredForReview: true },
        { id: 'source', label: 'Latest source evidence', state: sourceCurrent ? 'passed' : source ? 'needed' : 'unknown', detail: source ? `Saved receipt ${source.id}: ${source.state}.${sourceCurrent ? ' Complete source coverage was recorded for this account within the last five minutes.' : ' This receipt does not establish current coverage for these settings.'} Source evidence is separate from setup approval.` : 'No source acquisition receipt has been observed for this workflow.', nextAction: 'Run a bounded supervised source review and inspect its coverage receipt.', requiredForReview: false },
      ];
      const evidenceDigest = digest({ revision: state.revision, workflow, settings, properties: workflow === 'bank-references' ? observed.properties?.revision ?? null : null, gmail: mailRequired ? { accountId: gmail?.accountId ?? null, bindingRevision: gmail?.bindingRevision ?? null } : null, execution: execution?.bindingRevision ?? null });
      const selected = settings.selectedWorkflows.includes(workflow), canReview = selected && checks.filter(check => check.requiredForReview).every(check => check.state === 'passed');
      const reviewed = Boolean(state.reviews[workflow]?.settingsRevision === state.revision && state.reviews[workflow]?.evidenceDigest === evidenceDigest);
      const accepted = execution?.acceptanceReceipt;
      const acceptance = accepted?.id && accepted.settingsRevision === state.revision && accepted.evidenceDigest === evidenceDigest && accepted.acceptedAt >= (state.updatedAt ?? 0) && accepted.acceptedAt <= time ? 'accepted' as const : 'not-verified' as const;
      return { id: workflow, title: AGENCY_WORKFLOW_NAMES[workflow], selected, checks, evidenceDigest, canReview, reviewed, readyForRun: canReview && reviewed, acceptance };
    });
    return { state, accounts: gmail?.accounts ?? [], properties, workflows, canCheckGmail: Boolean(options.checkGmail) };
  }
  async function get() { const state = await read(); return project(state, await observations(state.settings)); }
  function expected(state: AgencySetupState, value: unknown) {
    if (!Number.isSafeInteger(value) || value !== state.revision) return fail('Agency setup changed elsewhere. Refresh before saving or reviewing.', 409, 'agency_setup_stale');
  }
  async function save(body: unknown) {
    const input = object(body, ['expectedRevision', 'settings']);
    return exclusive(async () => {
      const state = await read(); expected(state, input.expectedRevision);
      const settings = validateAgencySettings(input.settings), observed = await observations(settings);
      if (settings.gmailAccountId !== state.settings.gmailAccountId && settings.gmailAccountId && !observed.gmail?.accounts.some(account => account.id === settings.gmailAccountId && account.status === 'active')) return fail('Choose an available private Gmail account from Connections. No account was selected.', 409);
      const previousMappings = new Map(state.settings.propertyReferences.map(rule => [rule.propertyId, JSON.stringify(rule)]));
      if (settings.propertyReferences.some(rule => previousMappings.get(rule.propertyId) !== JSON.stringify(rule) && (observed.properties?.state !== 'available' || !observed.properties.items.some(property => property.id === rule.propertyId)))) return fail('A mapped property is unavailable in this workspace. Refresh the property list before saving.', 409);
      if (JSON.stringify(settings) === JSON.stringify(state.settings)) return project(state, observed);
      if (state.revision === Number.MAX_SAFE_INTEGER) return fail('Agency setup reached its revision limit. Existing settings were preserved; contact support before changing setup.', 409);
      const next: AgencySetupState = { ...state, revision: state.revision + 1, updatedAt: now(), settings, reviews: {} };
      await persist(next); return project(next, observed);
    });
  }
  async function review(workflow: AgencyWorkflowId, body: unknown) {
    const input = object(body, ['expectedRevision', 'expectedEvidenceDigest']);
    return exclusive(async () => {
      const state = await read(); expected(state, input.expectedRevision);
      // A review is always bound to a saved settings revision. Never persist a
      // revision 0 / updatedAt null state, which read() rejects as unreadable.
      if (!Number.isSafeInteger(state.revision) || state.revision < 1 || typeof state.updatedAt !== 'number') return fail('Save agency details before approving a workflow. No review was recorded.', 409);
      const view = project(state, await observations(state.settings)), current = view.workflows.find(item => item.id === workflow)!;
      if (input.expectedEvidenceDigest !== current.evidenceDigest) return fail('The source, mapping or plan changed. Review the latest setup checks.', 409);
      if (!current.canReview) return fail('Complete the required setup checks before approving these workflow settings.', 409);
      let recorded = false;
      if (!current.reviewed) { state.reviews[workflow] = { settingsRevision: state.revision, evidenceDigest: current.evidenceDigest, reviewedAt: now(), actorId: id(options.actorId()) }; await persist(state); recorded = true; }
      const after = project(state, await observations(state.settings));
      // Verification and the reviewed settings land in either order at first-time
      // setup, so the review that completes the pair offers the start too.
      return recorded && await offerHistory(after) ? project(state, await observations(state.settings)) : after;
    });
  }
  /** Evidence acquisition follows the projected check, never the callback alone:
   * the conditions that let a reviewer approve this source are what authorize
   * reading its history. The host starts at most one run per approval, and a
   * failure here is never a failed source check. */
  async function offerHistory(view: AgencySetupView): Promise<boolean> {
    const accountId = view.state.settings.gmailAccountId;
    if (!options.onGmailVerified || !accountId || !view.workflows.some(workflow => workflow.checks.some(check => check.id === 'gmail' && check.state === 'passed'))) return false;
    try { await options.onGmailVerified({ accountId, settingsRevision: view.state.revision, historyDays: view.state.settings.mailScope.historyDays }); }
    catch { /* acquisition is evidence, not authority */ }
    return true;
  }
  return {
    get, getConfiguration: read, save, review,
    async assertWorkflowReady(workflow: AgencyWorkflowId, expectedReview?: { revision: number; evidenceDigest: string }) {
      const view = await get(), result = view.workflows.find(item => item.id === workflowId(workflow))!;
      expected(await read(), view.state.revision);
      if (!result.readyForRun) return fail('This agency workflow needs current source checks and reviewed settings. Open Agency workflow setup.', 409, 'agency_workflow_not_ready');
      if (expectedReview && (view.state.revision !== expectedReview.revision || result.evidenceDigest !== expectedReview.evidenceDigest)) return fail('The approved agency source scope changed while this work was starting. No new read was authorized.', 409, 'agency_setup_stale');
      return { settings: view.state.settings, revision: view.state.revision, evidenceDigest: result.evidenceDigest };
    },
    async handle(route: string, method: string, body?: unknown): Promise<{ status: number; body: unknown } | null> {
      if (!route.startsWith('/api/agency-setup')) return null;
      if (route === '/api/agency-setup' && method === 'GET') return { status: 200, body: await get() };
      if (route === '/api/agency-setup' && method === 'PUT') return { status: 200, body: await save(body) };
      if (route === '/api/agency-setup/check-gmail' && method === 'POST') {
        const input = object(body, ['expectedRevision']);
        const state = await read(); expected(state, input.expectedRevision);
        if (!state.settings.gmailAccountId || !options.checkGmail) return fail('Choose an account and use Connections to verify its private read access.', 409);
        await options.checkGmail(state.settings.gmailAccountId, state.revision);
        expected(await read(), state.revision);
        const view = await get();
        return { status: 200, body: await offerHistory(view) ? await get() : view };
      }
      const match = route.match(/^\/api\/agency-setup\/workflows\/([a-z-]+)\/review$/);
      if (match && method === 'POST') return { status: 200, body: await review(workflowId(match[1]), body) };
      return { status: 404, body: { error: 'Unknown agency setup action.' } };
    },
  };
}
