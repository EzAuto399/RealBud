/** Disposable QA only: real admitted Hermes source, fictional local inference. */
import { mkdirSync, readdirSync, symlinkSync, writeFileSync, cpSync, readFileSync, chmodSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';

export const departmentWorkerFixtureCommit = '345cd2b057a452236de401d3534b8502a7465e8d';
export const departmentWorkerFixtureKey = 'fictional-selected-profile-key';
export function createDepartmentWorkerFixture({ root, runtimeDirectory, baseUrl, profile = 'property' }) {
  if (!isAbsolute(root) || !isAbsolute(runtimeDirectory) || !/^property(?:-[a-z0-9-]+)?$/.test(profile)) throw new Error('Invalid disposable worker fixture.');
  const url = new URL(baseUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash) throw new Error('Fixture provider must be loopback.');
  const runtime = join(root, 'runtimes', departmentWorkerFixtureCommit, 'hermes-agent');
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(runtimeDirectory)) if (!['.git', '.env'].includes(name)) symlinkSync(join(runtimeDirectory, name), join(runtime, name));
  writeFileSync(join(root, 'realbud-runtime.json'), JSON.stringify({ version: 1, selected: departmentWorkerFixtureCommit, previous: null }), { mode: 0o600 });
  const profileDirectory = join(root, 'profiles', profile);
  cpSync(fileURLToPath(new URL('../../pack/property', import.meta.url)), profileDirectory, { recursive: true });
  function privateModes(directory) {
    chmodSync(directory, 0o700);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) privateModes(join(directory, entry.name)); else chmodSync(join(directory, entry.name), 0o600);
    }
  }
  privateModes(profileDirectory);
  const configPath = join(profileDirectory, 'config.yaml');
  const config = parse(readFileSync(configPath, 'utf8'));
  config.model = { default: 'fictional-case-model', provider: 'custom', base_url: baseUrl };
  config.approvals = { mode: 'manual' };
  writeFileSync(configPath, stringify(config), { mode: 0o600 });
  writeFileSync(join(profileDirectory, '.env'), `OPENAI_API_KEY=${departmentWorkerFixtureKey}\n`, { mode: 0o600 });
  return { root, runtimeDirectory: runtime, profileDirectory, profile, model: 'fictional-case-model' };
}

/** A minimal real OpenAI streaming response, including tool-call turns. */
export function sendDepartmentWorkerFixtureResponse(response, requestBody, message) {
  const base = { id: 'fictional-department-response', object: 'chat.completion.chunk', created: 1, model: 'fictional-case-model' };
  if (requestBody.stream) {
    const delta = { ...message };
    if (delta.tool_calls) delta.tool_calls = delta.tool_calls.map((call, index) => ({ ...call, index }));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
  } else {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: 'stop' }] }));
  }
}
