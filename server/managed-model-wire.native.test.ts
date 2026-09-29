/**
 * Wire proof for the three managed model choices against the REAL installed
 * worker CLI (Hermes 0.21.3). A local HTTP capture server stands in for the
 * gateway's /chat/completions; the key is fictional and exists only in the
 * launch environment. Gated: set REALBUD_TEST_HERMES_CLI to the admitted
 * runtime's `hermes-agent/venv/bin/hermes`.
 *
 * What it proves, per choice: the profile RealBud writes makes the worker send
 * the chosen `model` and `reasoning_effort`, never `parallel_tool_calls`,
 * `tool_choice` or `temperature`, and authenticate with exactly the granted
 * key — through the same strip-then-grant env path every worker launch uses,
 * on a loopback gateway host for which upstream derives no key name itself.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyManagedModelProfile, applyPropertyPack, propertyProfileDir } from './hermes-pack.ts';
import { hardenHermesChildEnv } from './drivers/acp/hermes.ts';
import { applyManagedModelLaunchEnv, setWorkerModelAccessSnapshot } from './hermes-runtime-env.ts';
import { setWorkerModelGrant, workerModelEnv } from './worker-model-access.ts';
import { MANAGED_MODEL_CHOICES } from '../shared/managed-model-choices.ts';

const cli = process.env.REALBUD_TEST_HERMES_CLI;
const KEY = 'fictional-realbud-wire-key-0000';

interface Capture { method: string; url: string; authorization: string | null; body: Record<string, unknown> | null }

describe.runIf(Boolean(cli) && process.platform !== 'win32')('managed model choices on the real worker wire', () => {
  let server: Server, port = 0, root = '';
  const captures: Capture[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', chunk => chunks.push(chunk));
      request.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body: Record<string, unknown> | null = null;
        try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
        captures.push({ method: request.method ?? '', url: request.url ?? '', authorization: request.headers.authorization ?? null, body });
        if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
          response.writeHead(404, { 'content-type': 'application/json' }); response.end('{"error":{"message":"not found"}}'); return;
        }
        const model = String(body?.model ?? 'fictional');
        const base = { id: 'fictional-wire', created: 1, model };
        if (body?.stream) {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.end(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] })}\n\n`
            + `data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
        } else {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
        }
      });
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('capture server has no port');
    port = address.port;
    root = realpathSync(mkdtempSync(join(tmpdir(), 'realbud-managed-wire-')));
    applyPropertyPack(root);
  });

  afterAll(async () => {
    setWorkerModelGrant({ state: 'none' }); setWorkerModelAccessSnapshot({});
    server?.closeAllConnections();
    await new Promise<void>(done => server ? server.close(() => done()) : done());
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function launchEnv(): NodeJS.ProcessEnv {
    const home = join(root, 'home'); mkdirSync(home, { recursive: true });
    // Ambient decoys: none of these may reach the wire.
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', HOME: home, REALBUD_HERMES_HOME: root, LANG: 'C.UTF-8',
      OPENAI_API_KEY: 'wrong-ambient-openai', OPENAI_BASE_URL: 'http://127.0.0.1:9/v1', MODELVIA_API_KEY: 'wrong-ambient-modelvia',
      REALBUD_MODEL_API_KEY: 'wrong-ambient-grant' };
    hardenHermesChildEnv(env);
    // The production guard: the key is placed only while the profile names the granted endpoint.
    expect(applyManagedModelLaunchEnv(env, root)).toBeNull();
    return env;
  }

  function run(env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise(resolve => {
      execFile(cli!, ['--profile', 'property', 'chat', '-Q', '-q', 'Reply with OK.', '--max-turns', '1'],
        { env, cwd: root, timeout: 150_000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, stdout, stderr }));
    });
  }

  for (const choice of MANAGED_MODEL_CHOICES) {
    it(`${choice.id}: sends ${choice.model} with reasoning_effort ${choice.effort} and only the granted key`, async () => {
      const profile = propertyProfileDir(root);
      // Stale dotenv lines that would outrank the launch env are removed by the apply.
      writeFileSync(join(profile, '.env'), 'OPENAI_API_KEY=wrong-dotenv-openai\nREALBUD_MODEL_API_KEY=wrong-dotenv-grant\n', { mode: 0o600 });
      const applied = applyManagedModelProfile(`http://127.0.0.1:${port}/v1`, { root, choice: choice.id });
      setWorkerModelGrant({ state: 'active', baseUrl: `http://127.0.0.1:${port}/v1`, keyId: 'fictional-key-id', spendCapLabel: 'Fictional cap' });
      setWorkerModelAccessSnapshot(workerModelEnv(KEY));
      expect(applied).toMatchObject({ choice: choice.id, model: choice.model, reasoningEffort: choice.effort, envKeyRemoved: true });
      expect(readFileSync(join(profile, '.env'), 'utf8')).toBe('');
      expect(readFileSync(join(profile, 'config.yaml'), 'utf8')).not.toContain(KEY);

      captures.length = 0;
      const result = await run(launchEnv());
      const completions = captures.filter(row => row.method === 'POST' && row.url.endsWith('/chat/completions'));
      expect(result.code, result.stderr.slice(-400)).toBe(0);
      expect(completions.length).toBeGreaterThan(0);
      for (const row of completions) {
        expect(row.url).toBe('/v1/chat/completions');
        expect(row.authorization).toBe(`Bearer ${KEY}`);
        expect(row.body).toMatchObject({ model: choice.model, reasoning_effort: choice.effort });
        for (const field of ['parallel_tool_calls', 'tool_choice', 'temperature']) expect(row.body).not.toHaveProperty(field);
      }
      // Discovery probes may be sent, but never with a decoy credential.
      for (const row of captures) if (row.authorization) expect(row.authorization).toBe(`Bearer ${KEY}`);
      const { messages: _messages, tools, ...shape } = completions[0]!.body!;
      console.log(`[managed-wire] ${choice.id} ${JSON.stringify({ ...shape, tools: Array.isArray(tools) ? `${tools.length} tools` : 'none', authorization: `Bearer ${KEY.slice(0, 14)}…` })}`);
    }, 180_000);
  }
});
