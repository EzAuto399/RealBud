import type { IncomingMessage } from 'node:http';
import { Pool } from 'pg';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { windowsFilePrivacy } from './windows-file-privacy.ts';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ServiceAdminGate } from '../shared/service-admin.ts';
import { configuredCompanyKernel, createCompanyHost, companyMemberToken } from './company-host.ts';
import { createCompanyKernel } from './company/index.ts';
import { openOwnedPostgres } from './company/host-runtime.ts';
import { resolvePostgresRuntime } from './company/postgres-runtime.ts';
import { startCompanyTransport, requestCompanyHost } from './company/host-transport.ts';
import { createHostCertificate, validateHostCertificate, encodeCompanyPairing, parseCompanyPairing, type CompanyPairing } from './company/host-certificate.ts';

type Request = Pick<IncomingMessage, 'headers'>;
type Reply = { status: number; body: unknown };
type Settings = { version: 1; databasePort: number; network?: { hostname: string; port: number; cert: string; key: string } };
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
  /**
   * Called when this seat learns its member identity from a host session, so the
   * running desk can switch to that seat's worker profile without a restart. The
   * argument is the member id, never a display or login name.
   */
  onSeatIdentity?: (memberId: string) => void;
}) {
  const configured = configuredCompanyKernel();
  let kernel = configured.kernel;
  let pool: Pool | undefined;
  let runtime: Awaited<ReturnType<typeof openOwnedPostgres>> | undefined;
  let transport: Awaited<ReturnType<typeof startCompanyTransport>> | undefined;
  let settings: Settings | undefined;
  let peer: CompanyPairing | undefined;
  let failure = '';
  let storageRetryAvailable = false;
  let pending: Promise<unknown> | undefined;
  let closing: Promise<void> | undefined;
  const abort = new AbortController();
  const directory = join(options.dataDirectory, 'company-installation');
  const settingsPath = join(directory, 'host.json');
  const peerPath = join(directory, 'peer.json');
  const seatPath = join(directory, 'seat.json');

  /**
   * Record this seat's member identity from a host session response.
   *
   * Only the member id is kept. It is the stable, immutable identity
   * (`realbud_company.members.id`), and it is what the desk turns into a worker
   * profile — so a display name or login name must never be substituted here, and
   * the token itself is deliberately not stored.
   */
  async function adoptSeatIdentity(responseBody: unknown): Promise<void> {
    const member = (responseBody as { member?: { id?: unknown } } | null)?.member;
    const memberId = typeof member?.id === 'string' ? member.id.trim() : '';
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(memberId)) return;
    const existing = await readPrivate(seatPath) as { version?: number; memberId?: string } | undefined;
    if (existing?.version === 1 && existing.memberId === memberId) return;
    await persist(seatPath, { version: 1, memberId, adoptedAt: new Date().toISOString() });
    options.onSeatIdentity?.(memberId);
  }

  /**
   * The seat identity this computer recorded earlier, for boot.
   *
   * `adoptSeatIdentity` writing seat.json is not enough on its own: nothing read it
   * back, so after a restart a host whose owner had signed in lost its seat identity
   * and fell back to the shared base worker profile — the screen still showed them
   * signed in while their desk ran as the wrong Bud. Returns null when this computer
   * has never adopted an identity, which is every single-seat install.
   */
  async function seatIdentity(): Promise<string | null> {
    const saved = await readPrivate(seatPath) as { version?: number; memberId?: string } | undefined;
    const memberId = typeof saved?.memberId === 'string' ? saved.memberId.trim() : '';
    return saved?.version === 1 && /^[A-Za-z0-9_-]{8,64}$/.test(memberId) ? memberId : null;
  }
  const local = () => createCompanyHost({ kernel, authorizeAdmin: options.authorizeAdmin, hasAdminSession: options.hasAdminSession });
  async function privateDirectory() {
    const created = await mkdir(directory, { recursive: true, mode: 0o700 });
    const state = await lstat(directory);
    if (!state.isDirectory() || state.isSymbolicLink() || (process.platform !== 'win32' &&
      ((state.mode & 0o077) !== 0 || state.uid !== process.getuid?.()))) throw new Error('Company setup needs its own private directory.');
    await windowsFilePrivacy(directory, 'directory', created !== undefined);
  }
  async function readPrivate(path: string) {
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 20_000 || (process.platform !== 'win32' &&
        ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw new Error('Company setup file needs service attention.');
      await windowsFilePrivacy(path, 'file');
      return JSON.parse(await readFile(path, 'utf8')) as unknown;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  async function persist(path: string, value: unknown) {
    await privateDirectory();
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    try {
      await windowsFilePrivacy(temporary, 'file', true);
      await rename(temporary, path);
    } finally { await unlink(temporary).catch(() => {}); }
  }
  function validateSettings(value: unknown): Settings {
    const data = input(value, ['version', 'databasePort', 'network']);
    if (data.version !== 1 || !Number.isInteger(data.databasePort) || Number(data.databasePort) < 1024 || Number(data.databasePort) > 65535) throw new Error('Company host settings need service attention.');
    if (data.network) {
      const network = input(data.network, ['hostname', 'port', 'cert', 'key']);
      if (typeof network.hostname !== 'string' || typeof network.cert !== 'string' || typeof network.key !== 'string' || !Number.isInteger(network.port) || Number(network.port) < 1024 || Number(network.port) > 65535) throw new Error('Company network settings need service attention.');
      validateHostCertificate(network.cert, network.key, network.hostname);
    }
    return data as Settings;
  }
  async function listen() {
    if (!settings?.network || transport || !kernel || !options.previewEnabled) return;
    const network = settings.network;
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
    const candidateKernel = createCompanyKernel(candidatePool);
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
    const saved = await readPrivate(settingsPath);
    const savedPeer = await readPrivate(peerPath);
    if (saved && (kernel || savedPeer)) throw new Error('Conflicting company host settings need service attention.');
    if (savedPeer) {
      if (!options.previewEnabled || kernel) throw new Error('The company host connection is unavailable in this installation.');
      peer = parseCompanyPairing(savedPeer);
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
    /** The seat identity recorded on a previous run, or null. See `seatIdentity`. */
    seatIdentity,
    async handle(path: string, method: string, request: Request, body?: unknown): Promise<Reply> {
      await ready;
      if (abort.signal.aborted) return { status: 503, body: { error: 'The company service is stopping. Try again after restart.' } };
      try {
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
          const code = input(body, ['hostCode']).hostCode;
          return await exclusive(async () => {
            let target: CompanyPairing;
            try { target = parseCompanyPairing(code); }
            catch { return { status: 400, body: { code: 'invalid_host_code', error: 'This host code is invalid or expired. Copy a current code from the company owner.' } }; }
            if (peer && target.origin === peer.origin && target.companyId === peer.companyId && target.certificatePem === peer.certificatePem) {
              return { status: 200, body: { ok: true } };
            }
            if (kernel || settings || peer || failure) return { status: 409, body: { error: 'This computer already has company settings. Service attention is needed to change hosts.' } };
            const response = await requestCompanyHost({ ...target, path: '/api/company/status', method: 'GET', signal: abort.signal });
            if (response.status !== 200 || !(response.body as { configured?: boolean })?.configured) throw new Error('The company host is not ready. Check its address and try again.');
            if (abort.signal.aborted) throw new Error('Company setup stopped.');
            await persist(peerPath, code); peer = target;
            await adoptSeatIdentity(response.body);
            return { status: 200, body: { ok: true } };
          });
        }
        if (path === '/api/company/network' && method === 'POST') {
          const gate = options.authorizeAdmin(request);
          if (!gate.ok) return { status: gate.status, body: { error: gate.error } };
          if (!options.previewEnabled || !settings || !kernel) throw new Error('Set up this company host first.');
          const actor = await kernel.authenticateSession(companyMemberToken(request));
          if (actor.role !== 'owner') return { status: 403, body: { error: 'The company owner must enable joining.' } };
          const value = input(body, ['hostname']);
          return await exclusive(async () => {
            if (settings!.network) {
              if (String(value.hostname ?? '').trim() !== settings!.network.hostname) return { status: 409, body: { error: 'This host already has a saved network identity. Service attention is needed to change it without stranding connected computers.' } };
              await listen(); return { status: 200, body: { ok: true } };
            }
            const hostname = String(value.hostname ?? '').trim();
            const material = await createHostCertificate(hostname);
            const next = { ...settings!, network: { hostname, port: await vacantPort(), ...material } };
            await persist(settingsPath, next); settings = next; await listen();
            return { status: 200, body: { ok: true } };
          });
        }
        if (path === '/api/company/host-code' && method === 'GET') {
          if (!kernel || !settings?.network || !transport) return { status: 409, body: { error: 'Enable joining on this host first.' } };
          const actor = await kernel.authenticateSession(companyMemberToken(request));
          if (actor.role !== 'owner') return { status: 403, body: { error: 'Only the owner can share this host code.' } };
          const network = settings.network;
          const hostname = network.hostname.includes(':') ? `[${network.hostname}]` : network.hostname;
          return { status: 200, body: { hostCode: encodeCompanyPairing({ version: 1, origin: `https://${hostname}:${network.port}`, certificatePem: network.cert, companyId: actor.companyId }) } };
        }
        // A signed-in member is this seat's identity. Record it whenever the host
        // hands back a session, so the desk can resolve a per-seat worker profile.
        // Without this the only seat identity was an operator-set environment
        // variable, so a seat would run as the shared base profile and share one
        // memory with the others.
        //
        // `create` is included because the owner who sets up the office is the first
        // seat: it establishes their session too. Omitting it meant the host's own
        // owner had no seat identity, so after a restart their desk fell back to the
        // shared base profile while the screen still showed them signed in.
        const createsOrResumesSession = path === '/api/company/create' || path === '/api/company/sign-in'
          || path === '/api/company/join' || path === '/api/company/recover-member';
        if (createsOrResumesSession) {
          const response = peer
            ? await requestCompanyHost({ ...peer, path, method, memberToken: companyMemberToken(request) || undefined, body, signal: abort.signal })
            : await local().handle(path, method, request, body);
          if (response.status < 300) await adoptSeatIdentity(response.body);
          return response;
        }
        if (peer) {
          const response = await requestCompanyHost({ ...peer, path, method, memberToken: companyMemberToken(request) || undefined, body, signal: abort.signal });
          // A host identity mismatch never returns a member token to the renderer.
          const result = response.body as { company?: { id?: string }; transport?: string; limitations?: string[] };
          if (result?.company && result.company.id !== peer.companyId) throw new Error('The company identity does not match the saved host.');
          if (path === '/api/company/status' && response.status === 200) result.transport = 'encrypted-company';
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
            networkEnabled: !!transport, setupError: failure || undefined,
          });
        }
        return response;
      } catch { return { status: 503, body: { error: 'Company setup or connection could not be completed. Existing data and settings have been preserved.' } }; }
    },
    close() {
      return closing ??= (async () => {
        abort.abort(); await ready; await pending?.catch(() => {});
        const errors: unknown[] = [];
        for (const stop of [() => transport?.close(), () => pool?.end(), () => runtime?.stop(), () => configured.close()]) {
          try { await stop(); } catch (error) { errors.push(error); }
        }
        if (errors.length) throw new Error('Company shutdown needs service attention; data was preserved.');
      })();
    },
  };
}
