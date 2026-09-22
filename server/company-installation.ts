import type { IncomingMessage } from 'node:http';
import { Pool } from 'pg';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ServiceAdminGate } from '../shared/service-admin.ts';
import { configuredCompanyKernel, createCompanyHost, companyMemberToken } from './company-host.ts';
import { createCompanyKernel, CompanyError } from './company/index.ts';
import { normalizeLoginName } from './company/member-credentials.ts';
import { createCompanyRecovery } from './company-recovery.ts';
import { openOwnedPostgres } from './company/host-runtime.ts';
import { resolvePostgresRuntime } from './company/postgres-runtime.ts';
import { startCompanyTransport, requestCompanyHost, companyCertificateFingerprint } from './company/host-transport.ts';
import { createCompanyPortalProofVerifier, createCompanyPortalCertificateGate } from './company/portal-proof.ts';
import { createHostCertificate, validateHostCertificate, encodeCompanyPairing, parseCompanyPairing, type CompanyPairing } from './company/host-certificate.ts';
import { loadWorkspaceIdentity, type WorkspaceIdentity } from './workspace-identity.ts';
import { removePrivateJson, writePrivateJson, readPrivateJson, privateDirectory as ensurePrivateDirectory } from './private-json.ts';
import { createPrivateVault } from './private-vault.ts';
import { createCompanyOutbox } from './company-outbox.ts';
import { createCompanyDepartmentOutbox } from './company-department-outbox.ts';
import { createCompanyExecutionClient } from './company-execution-client.ts';

type Request = Pick<IncomingMessage, 'headers'>;
type Reply = { status: number; body: unknown };
type Settings = { version: 1; databasePort: number; network?: { hostname: string; port: number; cert: string; key: string } };
class CompanyBindingError extends Error {
  readonly code: 'host_identity_mismatch' | 'seat_identity_conflict';
  constructor(code: 'host_identity_mismatch' | 'seat_identity_conflict', message: string) { super(message); this.code = code; }
}
const input = (body: unknown, keys: string[]) => {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !keys.includes(key))) throw new Error('Check the setup fields.');
  return body as Record<string, unknown>;
};
async function vacantPort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

/** Trusted local controller. Company-only TLS never exposes the legacy app API. */
export function createCompanyInstallation(options: {
  dataDirectory: string; binaryDirectory?: string; previewEnabled?: boolean;
  /** Supplied by an installer that already staged a runtime. Omit to discover
   * the bundled runtime, which is the installed-office path. */
  resolveBinaryDirectory?: () => Promise<{ binaryDirectory: string }>;
  authorizeAdmin: (request: Request) => ServiceAdminGate;
  hasAdminSession: (request: Request) => boolean;
  /** Observe membership changes; private worker identity is fixed by workspace.json. */
  onSeatIdentity?: (memberId: string) => void;
  beforeSeatIdentity?: (memberId: string) => void;
  initialWorkerKey?: string;
  privateStateKey?: Buffer;
  /** Trusted service injection for a disposable issuer fixture; never an HTTP option. */
  portalProofVerifier?: ReturnType<typeof createCompanyPortalProofVerifier>;
  /** Trusted current worker/configuration digest; never selected by a renderer. */
  executionWorkerBinding?: () => string;
}) {
  let settings: Settings | undefined;
  const portalCertificateGate = createCompanyPortalCertificateGate();
  const portalBridge = {
    withCertificate: portalCertificateGate.run,
    certificateDigest: () => {
      if (!settings?.network) return null;
      const network = settings.network;
      try { validateHostCertificate(network.cert, network.key, network.hostname); return companyCertificateFingerprint(network.cert); }
      catch { return null; }
    },
    verify: options.portalProofVerifier ?? createCompanyPortalProofVerifier(),
  };
  const configured = configuredCompanyKernel({ portalBridge });
  let kernel = configured.kernel;
  let pool: Pool | undefined;
  let runtime: Awaited<ReturnType<typeof openOwnedPostgres>> | undefined;
  let transport: Awaited<ReturnType<typeof startCompanyTransport>> | undefined;
  let peer: CompanyPairing | undefined;
  let failure = '';
  let networkError = '';
  let storageRetryAvailable = false;
  let pending: Promise<unknown> | undefined;
  let closing: Promise<void> | undefined;
  const abort = new AbortController();
  const directory = join(options.dataDirectory, 'company-installation');
  const settingsPath = join(directory, 'host.json');
  const peerPath = join(directory, 'peer.json');
  const seatPath = join(directory, 'seat.json');
  const enrollmentPath = join(directory, 'enrollment.json');
  let workspace: WorkspaceIdentity | undefined;
  const vault = createPrivateVault(options.dataDirectory, options.privateStateKey);
  type OfflineDetachment = { version: 1; id: string; companyId: string; memberId: string | null; detachedAt: string; remoteRevocationConfirmed: false };
  type Departure = { version: 1; action: 'leave' | 'disconnect'; phase: 'pending' | 'confirmed' | 'complete'; operationToken: string; memberToken: string; offlineDetachment?: OfflineDetachment };
  function validateOfflineDetachment(value: unknown, legacy = false): OfflineDetachment {
    const record = value as OfflineDetachment | undefined;
    if (!record || record.version !== 1 || (!legacy && (typeof record.id !== 'string' || !/^[a-f0-9]{32}$/.test(record.id))) ||
      typeof record.companyId !== 'string' || !/^[a-f0-9-]{36}$/i.test(record.companyId) ||
      !(record.memberId === null || (typeof record.memberId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(record.memberId))) ||
      typeof record.detachedAt !== 'string' || !Number.isFinite(Date.parse(record.detachedAt)) || record.remoteRevocationConfirmed !== false) {
      throw new Error('Offline disconnect history needs recovery. Existing records have been kept.');
    }
    // Return only receipt fields, never an encrypted journal or its credentials.
    return { version: 1, id: legacy ? 'legacy' : record.id, companyId: record.companyId, memberId: record.memberId,
      detachedAt: record.detachedAt, remoteRevocationConfirmed: false };
  }
  async function offlineDetachments() {
    const list = await vault.names('offline-detachment-');
    const records = await Promise.all(list.names.map(async name => {
      const record = validateOfflineDetachment(await vault.read(name));
      if (name !== `offline-detachment-${record.id}`) throw new Error('Offline disconnect receipt identity needs recovery.');
      return record;
    }));
    // Older installations saved one encrypted receipt. Keep it readable without
    // replacing it, even after disconnecting from a different office later.
    const legacy = await vault.read('offline-detachment');
    if (legacy !== undefined) records.push(validateOfflineDetachment(legacy, true));
    records.sort((a, b) => Date.parse(b.detachedAt) - Date.parse(a.detachedAt) || a.id.localeCompare(b.id));
    return { records: records.slice(0, 50), hasMore: list.hasMore || records.length > 50 };
  }
  async function departure(): Promise<Departure | undefined> {
    const value = await vault.read('departure') as Departure | undefined;
    if (value === undefined) return undefined;
    if (!value || value.version !== 1 || !['leave', 'disconnect'].includes(value.action) || !['pending', 'confirmed', 'complete'].includes(value.phase) ||
      typeof value.operationToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.operationToken) || typeof value.memberToken !== 'string') throw new Error('Office departure needs recovery.');
    if (value.offlineDetachment !== undefined) {
      if (value.action !== 'disconnect' || value.memberToken !== '') throw new Error('Offline disconnect needs recovery.');
      validateOfflineDetachment(value.offlineDetachment);
    }
    return value;
  }
  async function finishDeparture(record: Departure) {
    // Journal first, then a separately retained receipt, then local detachment.
    // A crash at any point resumes the same receipt rather than overwriting a
    // previous office's unknown remote-access outcome.
    if (record.offlineDetachment) await vault.write(`offline-detachment-${record.offlineDetachment.id}`, record.offlineDetachment);
    await vault.write('departure', { ...record, phase: 'confirmed', memberToken: '' });
    for (const path of [peerPath, seatPath, enrollmentPath]) await removePrivateJson(path);
    peer = undefined;
    await vault.write('departure', { ...record, phase: 'complete', memberToken: '' });
  }

  /** Record membership only; the private workspace identity never changes on join. */
  let identityWrite: Promise<void> = Promise.resolve();
  async function adoptSeatIdentity(responseBody: unknown): Promise<void> {
    const next = identityWrite.then(() => persistSeatIdentity(responseBody));
    identityWrite = next.catch(() => {});
    await next;
  }
  async function persistSeatIdentity(responseBody: unknown): Promise<void> {
    const member = (responseBody as { member?: { id?: unknown } } | null)?.member;
    const memberId = typeof member?.id === 'string' ? member.id.trim() : '';
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(memberId)) return;
    const existing = await readPrivate(seatPath) as { version?: number; memberId?: string } | undefined;
    if (existing?.version === 1 && existing.memberId === memberId) return;
    if (existing !== undefined) throw new CompanyBindingError('seat_identity_conflict', 'This computer belongs to a different member. Use a separate RealBud data profile for another person.');
    options.beforeSeatIdentity?.(memberId);
    await persist(seatPath, { version: 1, memberId, adoptedAt: new Date().toISOString() });
    options.onSeatIdentity?.(memberId);
  }

  /** Membership previously bound to this private workspace, independent of Bud. */
  async function seatIdentity(): Promise<string | null> {
    const saved = await readPrivate(seatPath) as { version?: number; memberId?: string } | undefined;
    const memberId = typeof saved?.memberId === 'string' ? saved.memberId.trim() : '';
    if (saved === undefined) return null;
    if (!saved || saved.version !== 1 || !/^[A-Za-z0-9_-]{8,64}$/.test(memberId)) throw new Error('This computer’s saved member identity needs recovery. Bud has not been started.');
    return memberId;
  }
  const recovery = createCompanyRecovery({ directory, authorizeAdmin: options.authorizeAdmin,
    kernel: () => kernel, available: () => Boolean(runtime && kernel && !peer),
    withAdminPool: async work => {
      if (!runtime) throw new Error('Owned host required.');
      const adminPool = new Pool({ connectionString: runtime.adminUrl, max: 1, connectionTimeoutMillis: 2000, statement_timeout: 30_000 });
      adminPool.on('error', () => {});
      try { return await work(adminPool); } finally { await adminPool.end(); }
    },
  });
  const local = () => ({ handle: (path: string, method: string, request: Request, body?: unknown) => recovery.serve(path, () =>
    createCompanyHost({ kernel, authorizeAdmin: options.authorizeAdmin, hasAdminSession: options.hasAdminSession }).handle(path, method, request, body).then(reply => { if (path === '/api/company/status' && reply.status === 200) Object.assign(reply.body as object, { hostMode: recovery.mode() }); return reply; })) });
  const outbox = createCompanyOutbox({ vault,
    departurePending: async () => (await departure())?.phase === 'pending',
    matchesIdentity: async (companyId, memberId) => (!peer || peer.companyId === companyId) && (await seatIdentity()) === memberId,
    forward: (path, method, request, body) => peer
      ? requestCompanyHost({ ...peer, path, method, memberToken: companyMemberToken(request) || undefined, body, signal: abort.signal })
      : local().handle(path, method, request, body),
  });
  const departmentOutbox = createCompanyDepartmentOutbox({ vault,
    departurePending: async () => (await departure())?.phase === 'pending',
    matchesIdentity: async (companyId, memberId) => (!peer || peer.companyId === companyId) && (await seatIdentity()) === memberId,
    forward: (path, method, request, body) => peer
      ? requestCompanyHost({ ...peer, path, method, memberToken: companyMemberToken(request) || undefined, body, signal: abort.signal })
      : local().handle(path, method, request, body),
  });
  const departmentExecution = createCompanyExecutionClient({ vault,
    identity: async () => {
      await ready;
      const left = await departure();
      if (abort.signal.aborted || closing || pending || failure || left?.phase === 'pending' || !workspace || !options.executionWorkerBinding || (!peer && recovery.mode() !== 'active')) throw new Error('Department execution is held by the current installation state.');
      const memberId = await seatIdentity();
      const companies = !peer && kernel ? (await kernel.getBootstrapState()).companies : [];
      const companyId = peer?.companyId ?? (companies.length === 1 ? companies[0].companyId : null);
      const certificateDigest = peer ? companyCertificateFingerprint(peer.certificatePem) : portalBridge.certificateDigest();
      if (!memberId || !companyId || !certificateDigest) throw new Error('Join the current office and verify its host before department execution.');
      return { companyId, memberId, workspaceId: workspace.id, workerBinding: options.executionWorkerBinding(), certificateDigest };
    },
    forward: (path, auth, body) => peer
      ? requestCompanyHost({ ...peer, path, method: path === '/api/company/me' ? 'GET' : 'POST', ...auth, body, signal: abort.signal })
      : local().handle(path, path === '/api/company/me' ? 'GET' : 'POST', { headers: 'memberToken' in auth ? { 'x-realbud-member-session': auth.memberToken } : { 'x-realbud-execution-grant': auth.executionToken } }, body),
  });
  const pendingDepartmentReply = () => ({ status: 409, body: { code: 'department_outbox_pending', error: 'Confirm the saved department update, or explicitly archive its unknown outcome in Connection and work recovery, before leaving or replacing the host.' } });
  const privateDirectory = () => ensurePrivateDirectory(directory);
  const readPrivate = (path: string) => readPrivateJson(path, 20_000);
  const persist = writePrivateJson;
  function validateSettings(value: unknown): Settings {
    const data = input(value, ['version', 'databasePort', 'network']);
    if (data.version !== 1 || !Number.isInteger(data.databasePort) || Number(data.databasePort) < 1024 || Number(data.databasePort) > 65535) throw new Error('Company host settings need service attention.');
    if (data.network) {
      const network = input(data.network, ['hostname', 'port', 'cert', 'key']);
      if (typeof network.hostname !== 'string' || typeof network.cert !== 'string' || typeof network.key !== 'string' || !Number.isInteger(network.port) || Number(network.port) < 1024 || Number(network.port) > 65535) throw new Error('Company network settings need service attention.');
      validateHostCertificate(network.cert, network.key, network.hostname, { allowExpired: true });
    }
    return data as Settings;
  }
  async function listen() {
    if (runtime) await recovery.checkExistingHost();
    if (!settings?.network || transport || !kernel || !options.previewEnabled) return;
    const network = settings.network;
    try { validateHostCertificate(network.cert, network.key, network.hostname); }
    catch { networkError = 'The host network certificate has expired or needs renewal. Local office data remains available. Renew the network identity and give members a new host code.'; return; }
    networkError = '';
    transport = await startCompanyTransport({ host: '0.0.0.0', port: network.port, key: network.key, cert: network.cert,
      handle: (path, method, request, body) => local().handle(path, method, request, body) });
  }
  // Runtime admission is resolved once per process so a retry does not re-probe
  // the filesystem, and cleared on failure so "Set up this office" can pick up a
  // runtime that was repaired or installed after the first attempt. Nothing is
  // persisted: admission is re-derived every launch.
  let admittedBinaryDirectory: Promise<string> | undefined;
  function admitBinaryDirectory(): Promise<string> {
    if (!admittedBinaryDirectory) {
      admittedBinaryDirectory = (async () => {
        const explicit = options.binaryDirectory;
        const admitted = explicit ? { binaryDirectory: explicit } : await (options.resolveBinaryDirectory ?? resolvePostgresRuntime)();
        return admitted.binaryDirectory;
      })().catch(error => {
        admittedBinaryDirectory = undefined;
        throw error;
      });
    }
    return admittedBinaryDirectory;
  }
  async function startStorage() {
    if (kernel) return;
    if (!options.previewEnabled) throw new Error('The service installer has not admitted the host database runtime on this computer.');
    const admitted = await admitBinaryDirectory();
    await privateDirectory();
    if (!settings) {
      settings = { version: 1, databasePort: await vacantPort() };
      await persist(settingsPath, settings);
    }
    const candidateRuntime = await openOwnedPostgres({ rootDirectory: join(directory, 'postgres'), binaryDirectory: admitted, port: settings.databasePort, signal: abort.signal });
    const candidatePool = new Pool({ connectionString: candidateRuntime.applicationUrl, max: 4, connectionTimeoutMillis: 2000, statement_timeout: 10_000 });
    candidatePool.on('error', () => {});
    const candidateKernel = createCompanyKernel(candidatePool, { portalBridge });
    try {
      await candidateKernel.getBootstrapState();
    } catch (error) {
      await candidatePool.end().catch(() => {});
      await candidateRuntime.stop();
      throw error;
    }
    runtime = candidateRuntime; pool = candidatePool; kernel = candidateKernel;
    await listen();
    failure = ''; storageRetryAvailable = false;
  }
  const ready = (async () => {
    await privateDirectory();
    workspace = await loadWorkspaceIdentity(directory, options.initialWorkerKey);
    await recovery.load();
    const leaving = await departure();
    if (leaving?.phase === 'confirmed' || (leaving?.offlineDetachment && leaving.phase === 'pending')) await finishDeparture(leaving);
    const saved = await readPrivate(settingsPath);
    const savedPeer = await readPrivate(peerPath);
    if (saved && (kernel || savedPeer)) throw new Error('Conflicting company host settings need service attention.');
    if (savedPeer) {
      if (!options.previewEnabled || kernel) throw new Error('The company host connection is unavailable in this installation.');
      peer = parseCompanyPairing(savedPeer, { allowExpired: true });
    }
    if (saved) {
      settings = validateSettings(saved);
      storageRetryAvailable = true;
      await startStorage();
    }
  })().catch(() => { failure = 'Company startup needs service attention. Existing data and settings have been preserved.'; });
  async function exclusive(action: () => Promise<Reply>): Promise<Reply> {
    if (pending) return { status: 409, body: { error: 'Company setup is already running. Check status before retrying.' } };
    const operation = action(); pending = operation;
    try { return await operation; } finally { if (pending === operation) pending = undefined; }
  }
  return {
    /** Internal worker authority client, deliberately absent from HTTP routing. */
    departmentExecution,
    get privateRestoreFresh() { return !!workspace && !kernel && !settings && !peer && !pending && !closing && !failure; },
    async workspaceIdentity() { await ready; if (!workspace) throw new Error('Workspace identity needs recovery.'); return workspace; },
    /** The seat identity recorded on a previous run, or null. See `seatIdentity`. */
    seatIdentity,
    async handle(path: string, method: string, request: Request, body?: unknown): Promise<Reply> {
      await ready;
      if (abort.signal.aborted) return { status: 503, body: { error: 'The company service is stopping. Try again after restart.' } };
      try {
        if (recovery.handles(path)) return method === 'GET' ? await recovery.handle(path, method, request, body) : await exclusive(() => recovery.handle(path, method, request, body));
        // Local API only: these paths are absent from the LAN allowlist. The
        // current app user can recover their own journal even after revocation.
        if (path === '/api/company/local-state' && method === 'GET') {
          const leaving = await departure();
          return { status: 200, body: { workspaceId: workspace?.id, remoteHost: Boolean(peer), pendingShare: await outbox.localState(), pendingDepartmentOperation: await departmentOutbox.localState(), departure: leaving?.phase === 'pending' ? leaving.action : null, enrollmentPending: (await readPrivate(enrollmentPath)) !== undefined, offlineDetachments: await offlineDetachments() } };
        }
        if (path === '/api/company/department-outbox/archive' && method === 'GET') return { status: 200, body: await departmentOutbox.archives() };
        if (path === '/api/company/department-outbox/archive/export' && method === 'POST') {
          const value = input(body, ['requestId']);
          return await departmentOutbox.exportArchive(String(value.requestId ?? ''));
        }
        if (path === '/api/company/department-outbox/archive' && method === 'POST') {
          const value = input(body, ['requestId', 'acknowledgeUnknown']);
          return await outbox.serial(() => departmentOutbox.archive(String(value.requestId ?? ''), value.acknowledgeUnknown === true));
        }
        if (path === '/api/company/outbox/archive' && method === 'GET') return { status: 200, body: await outbox.archives() };
        if (path === '/api/company/outbox/archive/export' && method === 'POST') {
          const value = input(body, ['requestId']);
          return await outbox.exportArchive(String(value.requestId ?? ''));
        }
        if (path === '/api/company/outbox/archive' && method === 'POST') {
          const value = input(body, ['requestId', 'acknowledgeUnknown']);
          return await outbox.archive(String(value.requestId ?? ''), value.acknowledgeUnknown === true);
        }
        if (path === '/api/company/detach-offline' && method === 'POST') {
          const value = input(body, ['acknowledgeActiveSessions']);
          if (value.acknowledgeActiveSessions !== true) return { status: 400, body: { error: 'Acknowledge that remote membership and sessions may remain active.' } };
          return await exclusive(() => outbox.serial(async () => {
            const previous = await departure();
            if (!peer && previous?.phase === 'complete') return { status: 200, body: { ok: true, remoteRevocationConfirmed: false } };
            if (!peer) return { status: 409, body: { error: 'Only a remote host connection can be detached here.' } };
            if (!await outbox.departureAllowed()) return { status: 409, body: { code: 'outbox_pending', error: 'Resolve or explicitly archive the pending share first.' } };
            if (!await departmentOutbox.departureAllowed()) return pendingDepartmentReply();
            if (previous?.action === 'leave' && previous.phase === 'pending') return { status: 409, body: { code: 'departure_pending', error: 'Confirm whether the office departure completed before detaching.' } };
            const record: Departure = previous?.offlineDetachment && previous.phase === 'pending' ? previous : {
              version: 1, action: 'disconnect', phase: 'pending', operationToken: randomBytes(32).toString('base64url'), memberToken: '',
              offlineDetachment: { version: 1, id: randomBytes(16).toString('hex'), companyId: peer.companyId, memberId: await seatIdentity(), detachedAt: new Date().toISOString(), remoteRevocationConfirmed: false },
            };
            await vault.write('departure', record);
            await finishDeparture(record);
            return { status: 200, body: { ok: true, remoteRevocationConfirmed: false } };
          }));
        }
        if ((path === '/api/company/leave-office' || path === '/api/company/disconnect-host') && method === 'POST') {
          input(body, []);
          return await exclusive(() => outbox.serial(async () => {
            if (!await outbox.departureAllowed()) return { status: 409, body: { code: 'outbox_pending', error: 'Confirm the pending shared work before leaving or disconnecting.' } };
            if (!await departmentOutbox.departureAllowed()) return pendingDepartmentReply();
            const action = path.endsWith('/leave-office') ? 'leave' : 'disconnect';
            let record = await departure();
            if (record?.phase === 'complete') return { status: 200, body: { ok: true } };
            if (record && record.action !== action) return { status: 409, body: { code: 'departure_pending', error: 'Finish the pending office departure first.' } };
            if (!record) {
              if (action === 'disconnect' && !peer) return { status: 409, body: { error: 'This computer is not connected to a remote host.' } };
              const memberToken = companyMemberToken(request);
              if (action === 'leave' && !memberToken) return { status: 401, body: { error: 'Sign in before leaving the office.' } };
              if (memberToken) {
                const own = peer ? await requestCompanyHost({ ...peer, path: '/api/company/me', method: 'GET', memberToken, signal: abort.signal }) : await local().handle('/api/company/me', 'GET', request);
                if (own.status !== 200 && !(action === 'disconnect' && own.status === 401)) return own;
                const identity = own.body as { company?: { id?: string }; member?: { id?: string } };
                if (own.status === 200 && ((peer && identity.company?.id !== peer.companyId) || identity.member?.id !== await seatIdentity())) return { status: 403, body: { error: 'This office session does not match the private workspace.' } };
              }
              record = { version: 1, action, phase: 'pending', operationToken: randomBytes(32).toString('base64url'), memberToken };
              await vault.write('departure', record);
            }
            const forward = (target: string, payload: unknown) => peer
              ? requestCompanyHost({ ...peer, path: target, method: 'POST', memberToken: record!.memberToken || undefined, body: payload, signal: abort.signal })
              : local().handle(target, 'POST', { headers: { 'x-realbud-member-session': record!.memberToken } }, payload);
            if (action === 'leave') {
              const receipt = await forward('/api/company/membership/departure-status', { operationToken: record.operationToken });
              if (receipt.status !== 200) return receipt;
              if (!(receipt.body as { completed?: boolean })?.completed) {
                const left = await forward('/api/company/membership/leave', { operationToken: record.operationToken });
                if (left.status >= 300) {
                  // A 401 may mean the first attempt committed and revoked its
                  // session. Keep the receipt key and reconcile on the next click.
                  if (left.status >= 400 && left.status < 500 && left.status !== 401) await vault.remove('departure');
                  return left;
                }
              }
            } else {
              const out = await forward('/api/company/logout', {});
              if (out.status >= 300) return out;
            }
            await finishDeparture(record);
            return { status: 200, body: { ok: true } };
          }));
        }
        const leaving = await departure();
        if (leaving?.phase === 'pending' && !['/api/company/status', '/api/company/sign-in'].includes(path)) return { status: 409, body: { code: 'departure_pending', error: 'Finish the pending office departure before changing company state.' } };
        if (outbox.handles(path, method)) return await outbox.handle(path, method, request, body);
        if (departmentOutbox.handles(path, method)) return await outbox.serial(() => departmentOutbox.handle(path, method, request, body));
        if (path === '/api/company/setup' && method === 'POST') {
          const gate = options.authorizeAdmin(request);
          if (!gate.ok) return { status: gate.status, body: { error: gate.error } };
          input(body, []);
          if (peer) return { status: 409, body: { error: 'This computer is already connected to a company host.' } };
          if (failure && !storageRetryAvailable) return { status: 409, body: { error: failure } };
          return await exclusive(async () => {
            await startStorage(); await listen(); failure = ''; storageRetryAvailable = false;
            return { status: 200, body: { ok: true } };
          });
        }
        if (path === '/api/company/connect-host' && method === 'POST') {
          if (!options.previewEnabled) return { status: 503, body: { error: 'Remote company joining is not admitted in this installation.' } };
          const values = input(body, ['hostCode', 'replaceExisting']);
          const code = values.hostCode;
          return await exclusive(() => outbox.serial(async () => {
            let target: CompanyPairing;
            try { target = parseCompanyPairing(code); }
            catch { return { status: 400, body: { code: 'invalid_host_code', error: 'This host code is invalid or expired. Copy a current code from the company owner.' } }; }
            if (peer && target.origin === peer.origin && target.companyId === peer.companyId && target.certificatePem === peer.certificatePem) {
              return { status: 200, body: { ok: true } };
            }
            if (peer && values.replaceExisting === true && target.companyId !== peer.companyId) return { status: 409, body: { code: 'host_identity_mismatch', error: 'A replacement host must serve the same office. Leave or disconnect before changing offices.' } };
            if (peer && values.replaceExisting === true && !await outbox.departureAllowed()) return { status: 409, body: { code: 'outbox_pending', error: 'Resolve or explicitly archive the pending share before replacing this host.' } };
            if (!await departmentOutbox.departureAllowed()) return pendingDepartmentReply();
            if (kernel || settings || (peer && values.replaceExisting !== true) || failure) return { status: 409, body: { error: 'This computer already has company settings. Service attention is needed to change hosts.' } };
            const response = await requestCompanyHost({ ...target, path: '/api/company/status', method: 'GET', signal: abort.signal });
            if (response.status !== 200 || !(response.body as { configured?: boolean })?.configured) throw new Error('The company host is not ready. Check its address and try again.');
            if (abort.signal.aborted) throw new Error('Company setup stopped.');
            await persist(peerPath, code); peer = target;
            await vault.remove('departure');
            return { status: 200, body: { ok: true } };
          }));
        }
        if (path === '/api/company/network' && method === 'POST') {
          if (recovery.mode() !== 'active') return { status: 409, body: { code: 'host_held', error: 'Activate this host before enabling joining.' } };
          const gate = options.authorizeAdmin(request);
          if (!gate.ok) return { status: gate.status, body: { error: gate.error } };
          if (!options.previewEnabled || !settings || !kernel) throw new Error('Set up this company host first.');
          const actor = await kernel.authenticateSession(companyMemberToken(request));
          if (actor.role !== 'owner') return { status: 403, body: { error: 'The company owner must enable joining.' } };
          const value = input(body, ['hostname', 'renewIdentity']);
          return await exclusive(() => portalCertificateGate.run(async () => {
            if (settings!.network && value.renewIdentity !== true) {
              if (String(value.hostname ?? '').trim() !== settings!.network.hostname) return { status: 409, body: { error: 'This host already has a saved network identity. Service attention is needed to change it without stranding connected computers.' } };
              await listen(); return { status: 200, body: { ok: true } };
            }
            const hostname = String(value.hostname ?? '').trim();
            const material = await createHostCertificate(hostname);
            const next = { ...settings!, network: { hostname, port: settings!.network?.port ?? await vacantPort(), ...material } };
            if (transport) { await transport.close(); transport = undefined; }
            await persist(settingsPath, next); settings = next; await listen();
            return { status: 200, body: { ok: true } };
          }));
        }
        if (path === '/api/company/host-code' && method === 'GET') {
          if (!kernel || !settings?.network || !transport) return { status: 409, body: { error: 'Enable joining on this host first.' } };
          const actor = await kernel.authenticateSession(companyMemberToken(request));
          if (actor.role !== 'owner') return { status: 403, body: { error: 'Only the owner can share this host code.' } };
          const network = settings.network;
          const hostname = network.hostname.includes(':') ? `[${network.hostname}]` : network.hostname;
          return { status: 200, body: { hostCode: encodeCompanyPairing({ version: 1, origin: `https://${hostname}:${network.port}`, certificatePem: network.cert, companyId: actor.companyId }) } };
        }
        // Persist a recovery journal before any membership-creating operation.
        const createsOrResumesSession = method === 'POST' && (path === '/api/company/create' || path === '/api/company/sign-in'
          || path === '/api/company/join' || path === '/api/company/recover-member');
        if (createsOrResumesSession) {
          return await exclusive(async () => {
          const savedSeat = await seatIdentity();
          if (savedSeat && (path.endsWith('/join') || path.endsWith('/create'))) return { status: 409, body: { code: 'seat_identity_conflict', error: 'This workspace already has a member. Sign in as that person.' } };
          const previous = await readPrivate(enrollmentPath) as { version?: number; loginName?: string } | undefined;
          if (previous && path !== '/api/company/sign-in') return { status: 409, body: { code: 'enrollment_recovery_required', error: 'A previous sign-in operation needs confirmation. Sign in with the details you chose to finish.' } };
          const loginName = normalizeLoginName((body as { loginName?: unknown; credential?: { loginName?: unknown } })?.loginName ?? (body as { credential?: { loginName?: unknown } })?.credential?.loginName);
          if (previous && previous.loginName !== loginName) return { status: 409, body: { code: 'enrollment_recovery_required', error: 'Sign in using the username from the unfinished operation.' } };
          // No password, invitation, recovery key or session token is persisted.
          await writePrivateJson(enrollmentPath, { version: 1, loginName, operation: path, startedAt: new Date().toISOString() });
          const response = peer
            ? await requestCompanyHost({ ...peer, path, method, memberToken: companyMemberToken(request) || undefined, body, signal: abort.signal })
            : await local().handle(path, method, request, body);
          // TLS pins a computer, not its company data. A restored or replaced
          // database must not silently bind this seat to a different company.
          // Check before persisting identity or returning session credentials.
          if (peer && response.status >= 200 && response.status < 300 &&
            (response.body as { company?: { id?: unknown } } | null)?.company?.id !== peer.companyId) {
            throw new CompanyBindingError('host_identity_mismatch', 'The company identity does not match the saved host.');
          }
          if (response.status < 300) {
            try { await adoptSeatIdentity(response.body); }
            catch (error) {
              // A fresh rejected sign-in must not trap the original member behind
              // the other username. No membership was created by sign-in.
              if (!previous && path.endsWith('/sign-in') && error instanceof CompanyBindingError) await removePrivateJson(enrollmentPath);
              throw error;
            }
            if (leaving?.phase === 'pending') await vault.write('departure', { ...leaving, memberToken: (response.body as { memberToken: string }).memberToken });
            else await vault.remove('departure');
          }
          if (response.status < 300 || (!previous && response.status >= 400 && response.status < 500)) await removePrivateJson(enrollmentPath);
          return response;
          });
        }
        if (peer) {
          const response = await requestCompanyHost({ ...peer, path, method, memberToken: companyMemberToken(request) || undefined, body, signal: abort.signal });
          // A host identity mismatch never returns a member token to the renderer.
          const result = response.body as { company?: { id?: string }; transport?: string; limitations?: string[] };
          if (result?.company && result.company.id !== peer.companyId) throw new CompanyBindingError('host_identity_mismatch', 'The company identity does not match the saved host.');
          if (path === '/api/company/status' && response.status === 200) result.transport = 'encrypted-company';
          if (path === '/api/company/status' && response.status === 200) Object.assign(result, { enrollmentPending: (await readPrivate(enrollmentPath)) !== undefined, remoteHost: true, departurePending: leaving?.phase === 'pending' ? leaving.action : undefined });
          return response;
        }
        const response = await local().handle(path, method, request, body);
        if (path === '/api/company/status' && response.status === 200) {
          // Admission discovers the bundled Postgres runtime. Do not require
          // options.binaryDirectory — that hid "Set up this computer as host"
          // after the installer stopped passing REALBUD_COMPANY_POSTGRES_BIN.
          const admin = options.hasAdminSession(request);
          Object.assign(response.body as object, {
            storageSetupAvailable: !!options.previewEnabled && !peer && admin && (!failure || storageRetryAvailable),
            remoteJoinAvailable: !!options.previewEnabled && !settings && !kernel && !failure,
            hostingAvailable: !!options.previewEnabled && !!settings && !!kernel,
            networkEnabled: !!transport && recovery.mode() === 'active', hostMode: recovery.mode(), hostRecoveryAvailable: Boolean(runtime), networkError: networkError || undefined, setupError: failure || undefined,
            enrollmentPending: (await readPrivate(enrollmentPath)) !== undefined,
            remoteHost: false, departurePending: leaving?.phase === 'pending' ? leaving.action : undefined,
          });
        }
        return response;
      } catch (error) {
        if (error instanceof CompanyError && error.code === 'invalid_input') return { status: 400, body: { code: error.code, error: 'Check the company fields and username before retrying.' } };
        if (error instanceof CompanyBindingError) return { status: 409, body: { code: error.code, error: error.message } };
        return { status: 503, body: { error: 'Company setup or connection could not be completed. Existing data and settings have been preserved.' } };
      }
    },
    close() {
      return closing ??= (async () => {
        abort.abort(); await ready; await pending?.catch(() => {}); await outbox.drain(); await departmentOutbox.drain(); await departmentExecution.drain();
        const errors: unknown[] = [];
        for (const stop of [() => transport?.close(), () => pool?.end(), () => runtime?.stop(), () => configured.close()]) {
          try { await stop(); } catch (error) { errors.push(error); }
        }
        if (errors.length) throw new Error('Company shutdown needs service attention; data was preserved.');
      })();
    },
  };
}
