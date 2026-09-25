/** Assigned-case preparation never enters a private Hermes conversation. */
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type Server } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { windowsFilePrivacySync } from './windows-file-privacy.ts';
import { managedServiceFailure } from './managed-service.ts';
import { approvalsAreManual, packInstalled, propertyProfileDir } from './hermes-pack.ts';
import { currentWorkerProfile } from './hermes-profile.ts';
import { hermesHome, runtimeCli } from './hermes-paths.ts';
import { readRuntimeSelection, releaseHome, runtimeCommit, selectedHermesCli } from './hermes-runtime-selection.ts';
import { hermesIsCompatible } from './hermes-pin.ts';
import { probeHermesVersion } from './hermes-status.ts';
import { spawnCli, killCliTree } from './procs.ts';
import { augmentedPath } from './env-path.ts';
import { modelServiceFailure } from './model-service-failure.ts';
import { modelviaRefusal } from '../shared/modelvia-receipt.ts';

export const DEPARTMENT_WORKER_RUNTIME = '345cd2b057a452236de401d3534b8502a7465e8d';
// Runtime changes require a new isolation capture, rather than admitting a
// version label alone. These are the adapter's routing/context/tool seams.
const nativeFiles: Record<string, string> = {
  'run_agent.py': 'dc125031d13e2a341eec473bcfcafce16c7356505dcbc560bec562b1ecaddc04',
  'agent/agent_init.py': 'd1a1df8dc03a1381a9fd7591d4293e912fb1cb0fa2c1370f8c72a7500acb824a',
  'agent/system_prompt.py': '20a6b326816fc6924ed0b5f4407281b38b9254f7b43465acff10fae09be3114f',
  'agent/prompt_builder.py': '586ea363fa1e70bb0fdd5426af40758976a16c54f07efeb7a1b4f3fe0ad99309',
  'hermes_cli/runtime_provider.py': '013831a166ff862fbc4284d43556f9bd124ecd8beaadce3b4adc9d9fc0032f17',
  'hermes_cli/config.py': 'd76471ce54d40e68165e2cce7c2ade9c2164ed5ce4dbcf673b1b289cb89c7d84',
  'hermes_cli/env_loader.py': '4bdeccecea814299627f0e1a4fb54f9e93ba48a01f35b966337f7ad9a826f798',
  'model_tools.py': 'c99620c824ab59f341ac7d0e22cde016b0c469d0643e7a5a5a82e0d63176e4b5',
  'toolsets.py': '7d743a132c00417604313c9832286825771c3da79a82a9c6c0308c82d77236fa',
  'tools/todo_tool.py': 'cd86aad0d6545d2085824049085e5e65a9fd51022d2af254a7679a9cb3525c66',
  'tools/registry.py': '310a57a5dc5d41c935eacbe707e8a258dc21fd72fd44fccbc33d1a78b7143922',
};
const helper = fileURLToPath(new URL('./helpers/department-worker.py', import.meta.url));

/**
 * The `Idempotency-Key` for one relayed inference request. One logical request
 * is one body within one run: an SDK retry of that body after a lost reply
 * carries the same key, so Modelvia answers it with the original receipt (409
 * `request_already_processed`) instead of charging again, while the same case
 * prepared again (a new run) is a new request even with a byte-identical body.
 * Without the header Modelvia derives a key from the body alone and refuses an
 * identical resend delivered moments earlier, which would refuse a genuine
 * second run. The run id is random and never leaves this process otherwise.
 */
export function relayIdempotencyKey(runId: string, body: Uint8Array): string {
  return `realbud-case-${createHash('sha256').update(runId).update('\0').update(body).digest('hex').slice(0, 48)}`;
}
/** A known model-service refusal in an upstream error body, as one sentence the
 * office can act on; null for anything else. The body is never surfaced. */
export function relayRefusalDetail(status: number, body: Uint8Array): string | null {
  if (status < 400 || body.length > 64 * 1024) return null;
  let parsed: unknown; try { parsed = JSON.parse(Buffer.from(body).toString('utf8')); } catch { return null; }
  const refusal = modelviaRefusal(parsed), reason = refusal && modelServiceFailure(refusal.code);
  return reason ? `${reason[0]!.toUpperCase()}${reason.slice(1)}.` : null;
}
const unavailable = 'This worker route cannot prepare an isolated department case. Check the supported worker setup.';
const cancelled = 'Preparation cancelled.';
type Result = { ok: true; stdout: string } | { ok: false; detail: string };
export interface DepartmentWorkerOptions {
  signal?: AbortSignal;
  /** The caller rechecks company/claim/worker authority immediately before spawn. */
  beforeLaunch?: () => Promise<void>;
  /** Checked before every inference HTTP request, including SDK retries. */
  beforeRequest?: () => Promise<void>;
  timeoutMs?: number;
  maxTurns?: number;
  /** Trusted local test/configuration seam; never supplied by a renderer. */
  root?: string;
}

export async function askDepartmentWorker(prompt: string, opts: DepartmentWorkerOptions = {}): Promise<Result> {
  let scratch: string | undefined;
  let relay: Server | undefined;
  const forwarding = new AbortController();
  try {
    if (opts.signal?.aborted) return { ok: false, detail: cancelled };
    if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > 64 * 1024) return { ok: false, detail: unavailable };
    const failure = managedServiceFailure('reasoning'); if (failure) return { ok: false, detail: failure };
    const home = hermesHome(opts.root), selection = readRuntimeSelection(home).selected;
    const profile = currentWorkerProfile().profile, profileDirectory = propertyProfileDir(home);
    if (!selection || runtimeCommit(selection) !== DEPARTMENT_WORKER_RUNTIME || !packInstalled(home) || !approvalsAreManual(home)) return { ok: false, detail: unavailable };
    if (typeof opts.beforeLaunch !== 'function' || typeof opts.beforeRequest !== 'function') return { ok: false, detail: unavailable };
    const runtimeHome = releaseHome(home, selection), cli = selectedHermesCli(home);
    if (resolve(cli) !== resolve(runtimeCli(runtimeHome))) return { ok: false, detail: unavailable };
    const runtimeDirectory = join(runtimeHome, 'hermes-agent');
    const python = join(runtimeDirectory, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    if (!existsSync(python) || !existsSync(helper)) return { ok: false, detail: unavailable };
    for (const [file, digest] of Object.entries(nativeFiles)) if (createHash('sha256').update(await readFile(join(runtimeDirectory, file))).digest('hex') !== digest) return { ok: false, detail: unavailable };
    const version = await probeHermesVersion(cli);
    if (!version || !hermesIsCompatible(version)) return { ok: false, detail: unavailable };
    scratch = await mkdtemp(join(tmpdir(), 'realbud-department-'));
    windowsFilePrivacySync(scratch, 'directory', true);
    const token = randomBytes(32).toString('hex'), runId = randomBytes(16).toString('hex');
    let route: { base_url: string; api_key: string; model: string } | undefined;
    let refusal: string | null = null;
    let deny: () => void = () => {};
    relay = createServer(async (request, response) => {
      try {
        // Hermes probes local-server metadata for a loopback base URL. This
        // adapter never forwards discovery or reads any external catalog.
        if (request.method === 'GET' || request.url === '/api/show') { request.resume(); response.writeHead(404); response.end(); return; }
        if (request.method !== 'POST' || request.headers.authorization !== `Bearer ${token}` && request.headers['x-api-key'] !== token) { request.resume(); response.writeHead(403); response.end(); return; }
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of request) { size += chunk.length; if (size > 512 * 1024) throw new Error(); chunks.push(chunk); }
        const body = Buffer.concat(chunks);
        if (request.url === '/configure') {
          if (route) throw new Error();
          const value = JSON.parse(body.toString('utf8'));
          if (typeof value.base_url !== 'string' || typeof value.model !== 'string' || !value.model || value.model.length > 200 || typeof value.api_key !== 'string' || !value.api_key || value.api_key.length > 16384 || value.api_mode !== 'chat_completions') throw new Error();
          const url = new URL(value.base_url);
          if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error();
          route = { base_url: value.base_url.replace(/\/$/, ''), api_key: value.api_key, model: value.model };
          response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end('{}'); return;
        }
        if (!route || request.url !== '/chat/completions') throw new Error();
        const inference = JSON.parse(body.toString('utf8'));
        if (inference.model !== route.model || inference.tools !== undefined && (!Array.isArray(inference.tools) || inference.tools.some((tool: { function?: { name?: string } }) => tool.function?.name !== 'todo_list'))) throw new Error();
        await opts.beforeRequest?.();
        if (opts.signal?.aborted || forwarding.signal.aborted || managedServiceFailure('reasoning')) throw new Error();
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        headers.authorization = `Bearer ${route.api_key}`;
        headers['idempotency-key'] = relayIdempotencyKey(runId, body);
        const upstream = await fetch(route.base_url + request.url, { method: 'POST', headers, body, redirect: 'error', signal: forwarding.signal });
        const received: Uint8Array[] = []; let total = 0;
        if (upstream.body) for await (const part of upstream.body) { total += part.length; if (total > 2 * 1024 * 1024) throw new Error(); received.push(part); }
        refusal = relayRefusalDetail(upstream.status, Buffer.concat(received)) ?? refusal;
        response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json', 'cache-control': 'no-store' });
        response.end(Buffer.concat(received));
      } catch {
        try { if (!response.headersSent && !response.destroyed) { response.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end('{"error":"Preparation authority unavailable"}'); } }
        finally { deny(); }
      }
    });
    relay.requestTimeout = 300_000; relay.headersTimeout = 10_000;
    await new Promise<void>((accept, reject) => { relay!.once('error', reject); relay!.listen(0, '127.0.0.1', accept); });
    const address = relay.address(); if (!address || typeof address === 'string') throw new Error();
    const relayUrl = `http://127.0.0.1:${address.port}`;
    await opts.beforeLaunch?.();
    if (opts.signal?.aborted) return { ok: false, detail: cancelled };
    if (currentWorkerProfile().profile !== profile || readRuntimeSelection(home).selected !== selection || !approvalsAreManual(home)) return { ok: false, detail: unavailable };
    const lastFailure = managedServiceFailure('reasoning'); if (lastFailure) return { ok: false, detail: lastFailure };
    const env: NodeJS.ProcessEnv = { PATH: augmentedPath(), HERMES_HOME: profileDirectory, HERMES_SAFE_MODE: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHON_DOTENV_DISABLED: '1' };
    for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL']) if (process.env[key]) env[key] = process.env[key];
    // Provider OAuth/CLI discovery must not reach the OS user's home either.
    Object.assign(env, { HOME: scratch, USERPROFILE: scratch, TMPDIR: scratch, TMP: scratch, TEMP: scratch });
    return await new Promise<Result>(accept => {
      const child = spawnCli(python, ['-I', '-B', helper], { cwd: scratch, env, stdio: ['pipe', 'pipe', 'pipe'], privateFiles: true });
      let size = 0, killed = false, failed = false;
      const chunks: Buffer[] = [];
      let force: ReturnType<typeof setTimeout> | undefined;
      const stop = () => { if (!killed) { killed = true; forwarding.abort(); killCliTree(child); force = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 2000); force.unref(); } };
      deny = stop;
      const timer = setTimeout(stop, Math.max(1, Math.min(300_000, opts.timeoutMs ?? 120_000)));
      timer.unref(); opts.signal?.addEventListener('abort', stop, { once: true });
      child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 192 * 1024) stop(); else chunks.push(Buffer.from(chunk)); });
      child.stderr.on('data', () => {});
      child.on('error', () => { failed = true; }); child.stdin.on('error', stop);
      child.once('close', code => {
        clearTimeout(timer); opts.signal?.removeEventListener('abort', stop);
        if (force) clearTimeout(force);
        const bytes = Buffer.concat(chunks); chunks.forEach(chunk => chunk.fill(0));
        try {
          if (opts.signal?.aborted) return accept({ ok: false, detail: cancelled });
          if (killed || failed || code !== 0) return accept({ ok: false, detail: refusal ?? unavailable });
          const result = JSON.parse(bytes.toString('utf8'));
          if (result?.ok !== true || typeof result.stdout !== 'string' || Object.keys(result).sort().join(',') !== 'ok,stdout') return accept({ ok: false, detail: refusal ?? unavailable });
          accept({ ok: true, stdout: result.stdout });
        } catch { accept({ ok: false, detail: unavailable }); } finally { bytes.fill(0); }
      });
      child.stdin.end(JSON.stringify({ runtimeDirectory, prompt, relayUrl, relayToken: token, maxTurns: Math.max(1, Math.min(12, Math.floor(opts.maxTurns ?? 6))) }));
    });
  } catch { return { ok: false, detail: opts.signal?.aborted ? cancelled : unavailable }; }
  finally {
    forwarding.abort();
    if (relay) { relay.closeAllConnections(); await new Promise<void>(done => relay!.close(() => done())); }
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
