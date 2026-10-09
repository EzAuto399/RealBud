/** Manual mail-outcome recovery belongs only to the authenticated desktop GUI.
 * The worker broker exposes no method/tool that can grant this authority. */
import { createHash, randomUUID } from 'node:crypto';
import { CHANGED_CONNECTION_MAIL_ACKNOWLEDGEMENT, MANUAL_MAIL_ACKNOWLEDGEMENT, connectedAppCanonical, opaqueDigest, parseConnectedMailBindings, parseConnectedMailReview, verifiedMailAddress, connectedMailGatewayOrigin, type ConnectedMailBinding, type ConnectedMailReviewArtifacts } from '../shared/connected-app-binding.ts';
import { mailAccountDigest, mailRealmDigest } from './connected-apps-broker.ts';
import { type ConnectedAppOperation, type ConnectedAppOperationStore } from './connected-app-operations.ts';
import { readMcpRpcResponse } from './composio.ts';

const refuse = (message: string, status = 409, code?: string): never => { throw Object.assign(new Error(message), { status, ...(code ? { code } : {}) }); };
/** The renderer offers the owner check for this code (src/lib/connected-apps.ts). */
export const EARLIER_CONNECTION_CODE = 'mail_receipt_earlier_connection';
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const digest = (value: unknown) => createHash('sha256').update(connectedAppCanonical(value)).digest('hex');
/** An exact host-only namespace. These names are not workspace/worker files
 * and no generic artifact endpoint lists or reads this protected vault. */
export function createConnectedMailReviewArtifacts(vault: { read(name: string): Promise<unknown>; write(name: string, value: unknown): Promise<void> }): ConnectedMailReviewArtifacts {
  const name = (id: string) => { if (!opaqueDigest(id)) return refuse('Original mail review identity needs recovery.'); return `mail-review-${id}`; };
  return {
    async read(id) { const saved = await vault.read(name(id)); return saved === undefined ? undefined : parseConnectedMailReview(saved, digest); },
    async write(value) {
      const parsed = parseConnectedMailReview(value, digest), key = name(parsed.reviewDigest), saved = await vault.read(key);
      if (saved !== undefined) {
        const previous = parseConnectedMailReview(saved, digest);
        if (connectedAppCanonical({ ...previous, approvedAt: 0 }) !== connectedAppCanonical({ ...parsed, approvedAt: 0 })) return refuse('Original mail review cannot be overwritten.');
        return;
      }
      await vault.write(key, parsed);
      const reread = await vault.read(key);
      if (reread === undefined || connectedAppCanonical(parseConnectedMailReview(reread, digest)) !== connectedAppCanonical(parsed)) return refuse('Original mail review could not be durably verified.');
    },
  };
}

/** Settings come from the host's current private configuration, never a body. */
export async function readCurrentConnectedMailBindings(settings: { url: string; headers: Record<string, string> }, signal: AbortSignal): Promise<ConnectedMailBinding[]> {
  const id = `bud-mail-recovery-${randomUUID()}`;
  const response = await fetch(settings.url, { method: 'POST', redirect: 'error', signal,
    headers: { ...settings.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'realbud/mail-binding' }) });
  if (!response.ok) { await response.body?.cancel().catch(() => {}); return refuse('The verified mail connection could not be checked. The original outcome remains held. Check Connected apps and recover that exact connection.'); }
  const result = await readMcpRpcResponse(response, id, signal);
  try { return parseConnectedMailBindings(result.realbudMailBindings); }
  catch { return refuse('The managed connector cannot verify the original account and generation. Update/check Connected apps before recording an outcome.'); }
}

type RecoveryOptions = {
    store: ConnectedAppOperationStore;
    /** Canonical current managed origin supplied by host configuration only. */
    gatewayOrigin: () => string;
    /** Includes authoritative persisted workspace identity, profile, selected
     * connection config and policy revision; never sent to the renderer. */
    authority: () => string;
    assertAuthority: () => void;
    verifyAuthority?: () => Promise<void>;
    bindings: (signal: AbortSignal) => Promise<ConnectedMailBinding[]>;
    reviews: ConnectedMailReviewArtifacts;
  };
export class ConnectedAppRecovery {
  private readonly options: RecoveryOptions;
  constructor(options: RecoveryOptions) { this.options = options; }

  private row(id: string): ConnectedAppOperation {
    const row = this.options.store.list().find(item => item.id === id);
    if (!row) return refuse('No such app operation.', 404);
    if (!row.effectDigest && row.status === 'unknown') return refuse('This older receipt has no saved account details, so RealBud cannot check it against the mail account. Check its sent mail in the app, then use "I checked it in the app" in Connected apps.');
    if (!['unknown', 'failed'].includes(row.status) || !row.realmDigest || !row.effectDigest || !row.accountDigest || !row.bindingDigest || row.workspaceDigest !== this.options.store.workspaceDigest)
      return refuse('This receipt cannot be safely reconciled here. Older receipts without a verified account/payload identity remain held; restore their matching workspace and original connection history.');
    return row;
  }
  private async binding(row: ConnectedAppOperation, signal: AbortSignal): Promise<ConnectedMailBinding> {
    this.options.assertAuthority(); const before = this.options.authority();
    const bindings = await this.options.bindings(signal);
    signal.throwIfAborted(); this.options.assertAuthority();
    if (this.options.authority() !== before || row.workspaceDigest !== this.options.store.workspaceDigest) return refuse('The private workspace or connection changed while checking this receipt. Refresh and recover the original workspace before recording an outcome.');
    const binding = bindings.find(item => item.companyId && mailAccountDigest(item, connectedMailGatewayOrigin(this.options.gatewayOrigin())) === row.accountDigest && mailRealmDigest(item, this.options.gatewayOrigin()) === row.realmDigest);
    if (!binding) {
      // Saved under a company or managed gateway the current connection no
      // longer has: only the owner's check in the app can settle it.
      const realms = bindings.filter(item => item.companyId).map(item => mailRealmDigest(item, this.options.gatewayOrigin()));
      if (realms.length && !realms.includes(row.realmDigest!)) return refuse('This send was recorded under an earlier company or managed gateway, so RealBud can no longer check it against that connection. Look in that mailbox\'s Sent mail, then the office owner can mark it checked here.', 409, EARLIER_CONNECTION_CODE);
      return refuse('The original verified mail account, company or managed gateway changed. This outcome remains held. Restore/check that exact account before recording its outcome.');
    }
    if (!verifiedMailAddress(binding.emailAddress)) return refuse('The current mailbox has no verified sending address. Check the exact account/profile in Connected apps before recording this outcome.');
    return binding;
  }
  private async original(row: ConnectedAppOperation) {
    let original;
    try { original = await this.options.reviews.read(row.reviewDigest!); }
    catch { return refuse('The protected original approval review is damaged. Restore its matching encrypted review before recording this outcome.'); }
    if (!original || original.gatewayOrigin !== connectedMailGatewayOrigin(this.options.gatewayOrigin()) || original.workspaceDigest !== row.workspaceDigest || original.accountDigest !== row.accountDigest || original.bindingDigest !== row.bindingDigest || original.reviewDigest !== row.reviewDigest)
      return refuse('The protected original approval review is missing or belongs to another workspace/message. Restore that exact encrypted review before recording this outcome.');
    return original;
  }
  async prepare(id: string, signal: AbortSignal) {
    const before = this.options.authority();
    const row = this.row(id);
    // The current connection first, so a receipt from an earlier company or
    // managed gateway is named as such before its original review is compared.
    const binding = await this.binding(row, signal), original = await this.original(row);
    this.options.assertAuthority(); signal.throwIfAborted();
    if (this.options.authority() !== before) return refuse('The private workspace changed while loading the original review. Refresh this receipt.');
    await this.options.verifyAuthority?.();
    // The gateway's link generation can move independently while the owner
    // grant is awaited. Re-read it last; only synchronous local/CAS gates follow.
    const finalBinding = await this.binding(row, signal);
    if (connectedAppCanonical(finalBinding) !== connectedAppCanonical(binding)) return refuse('The mail connection changed while checking permission. Refresh and inspect the original message again.');
    this.options.assertAuthority(); signal.throwIfAborted();
    if (this.options.authority() !== before) return refuse('The private workspace or connection changed. Refresh this receipt before recording an outcome.');
    const current = this.row(id);
    if ((current.revision ?? 0) !== (row.revision ?? 0)) return refuse('This receipt changed. Refresh its outcome before recording a decision.');
    return { operationId: row.id, expectedRevision: row.revision ?? 0, toolName: row.toolName, account: { provider: binding.provider, accountId: binding.accountId, companyId: binding.companyId!, gatewayOrigin: original.gatewayOrigin, label: binding.emailAddress! },
      evidence: 'manual-app-inspection', acknowledgement: binding.generation === row.bindingDigest ? MANUAL_MAIL_ACKNOWLEDGEMENT : CHANGED_CONNECTION_MAIL_ACKNOWLEDGEMENT,
      recoveryBindingDigest: binding.generation, reviewDigest: row.reviewDigest, connectionChanged: binding.generation !== row.bindingDigest,
      originalReview: { card: original.card, exact: original.exact, approvedAt: original.approvedAt }, startedAt: row.startedAt,
      ...(row.reconciliation ? { reconciliation: { ...row.reconciliation } } : {}) };
  }
  /** The realms (company + managed gateway) of the current connection, read
   * from the gateway now. None verifiable means none can be ruled out. */
  private async currentRealms(signal: AbortSignal, before: string): Promise<string[]> {
    this.options.assertAuthority();
    const bindings = await this.options.bindings(signal);
    signal.throwIfAborted(); this.options.assertAuthority();
    if (this.options.authority() !== before) return refuse('The private workspace or connection changed while checking this receipt. Refresh and try again.');
    const realms = [...new Set(bindings.filter(item => item.companyId).map(item => mailRealmDigest(item, this.options.gatewayOrigin())))].sort();
    if (!realms.length) return refuse('The current mail connection could not confirm its company, so RealBud cannot tell whether this receipt is from an earlier connection. Check Connected apps, then try again.');
    return realms;
  }
  /** Owner step for an identified receipt saved under an earlier company or
   * managed gateway: it can no longer be checked against its original
   * connection, so the owner checks the app and marks it checked. Proves
   * nothing and never changes the recorded outcome; a receipt of the current
   * realm keeps exact-account recovery. */
  async acknowledgeEarlierRealm(id: string, expectedRevision: number, signal: AbortSignal): Promise<ConnectedAppOperation> {
    const before = this.options.authority();
    const row = this.options.store.list().find(item => item.id === id);
    if (!row) return refuse('No such app operation.', 404);
    if (!row.effectDigest || !row.realmDigest || row.workspaceDigest !== this.options.store.workspaceDigest)
      return refuse('This receipt cannot be marked checked here. Restore its matching workspace and original connection history.');
    const realms = await this.currentRealms(signal, before);
    if (realms.includes(row.realmDigest)) return refuse('This receipt belongs to the current company and managed gateway. Use Inspect and record mail outcome instead.');
    await this.options.verifyAuthority?.();
    // The connection can move while the owner grant is awaited; re-read it last.
    const finalRealms = await this.currentRealms(signal, before);
    if (connectedAppCanonical(finalRealms) !== connectedAppCanonical(realms)) return refuse('The mail connection changed while checking permission. Refresh and try again.');
    this.options.assertAuthority(); signal.throwIfAborted();
    // The store rechecks the realm, revision and disk generation under its lock.
    return this.options.store.acknowledge(id, expectedRevision, finalRealms);
  }
  async reconcile(id: string, body: unknown, signal: AbortSignal): Promise<ConnectedAppOperation> {
    if (!record(body) || Object.keys(body).sort().join(',') !== 'acknowledgement,expectedRevision,outcome,recoveryBindingDigest,reviewDigest' || ![MANUAL_MAIL_ACKNOWLEDGEMENT, CHANGED_CONNECTION_MAIL_ACKNOWLEDGEMENT].includes(String(body.acknowledgement)) || !opaqueDigest(body.recoveryBindingDigest) || !opaqueDigest(body.reviewDigest) ||
      !Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0 || !['sent', 'not-sent'].includes(String(body.outcome))) return refuse('Inspect the exact account in the mail app, then use its explicit recovery controls to record the outcome.', 400);
    const row = this.row(id);
    const before = this.options.authority();
    if (body.reviewDigest !== row.reviewDigest) return refuse('The original reviewed message changed. Refresh this receipt.');
    await this.original(row); this.options.assertAuthority(); signal.throwIfAborted();
    if (this.options.authority() !== before) return refuse('The private workspace changed while loading the original review. Refresh this receipt.');
    const binding = await this.binding(row, signal);
    if (binding.generation !== body.recoveryBindingDigest) return refuse('The connection changed again after this recovery was prepared. Refresh and inspect the original reviewed message in the exact account again.');
    const acknowledgement = binding.generation === row.bindingDigest ? MANUAL_MAIL_ACKNOWLEDGEMENT : CHANGED_CONNECTION_MAIL_ACKNOWLEDGEMENT;
    if (body.acknowledgement !== acknowledgement) return refuse('This connection changed. Explicitly confirm you inspected the original reviewed message in this exact account.', 400);
    await this.options.verifyAuthority?.();
    // The gateway's link generation can move independently while the owner
    // grant is awaited. Re-read it last; only synchronous local/CAS gates follow.
    const finalBinding = await this.binding(row, signal);
    if (connectedAppCanonical(finalBinding) !== connectedAppCanonical(binding)) return refuse('The mail connection changed while checking permission. Refresh and inspect the original message again.');
    this.options.assertAuthority(); signal.throwIfAborted();
    if (this.options.authority() !== before) return refuse('The private workspace or connection changed. Refresh this receipt before recording an outcome.');
    // Store rechecks disk generation and exact receipt revision under its
    // exclusive lock. Manual evidence never rewrites provider status to success.
    return this.options.store.reconcile(id, Number(body.expectedRevision), body.outcome as 'sent' | 'not-sent',
      { accountDigest: row.accountDigest!, realmDigest: row.realmDigest!, originalBindingDigest: row.bindingDigest!, recoveryBindingDigest: binding.generation, workspaceDigest: this.options.store.workspaceDigest });
  }
}
