#!/usr/bin/env node
// Fictional ACP peer for actual application wiring tests. Never calls a model.
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
if (process.argv.includes('--version')) { console.log('fictional-hermes 0.21.3'); process.exit(0); }
let descriptor, sequence = 1, prompts = 0;
const discovery = [], calls = [];
const save = () => writeFileSync(process.env.FAKE_MEMORY_OUTPUT, JSON.stringify({ pid: process.pid, prompts, discovery, calls }), { mode: 0o600 });
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
async function rpc(method, params) {
  if (!descriptor || !/^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(descriptor.url)) throw new Error('Missing private proposal broker.');
  const response = await fetch(descriptor.url, { method: 'POST', signal: AbortSignal.timeout(30_000), headers: {
    'content-type': 'application/json', ...Object.fromEntries(descriptor.headers.map(row => [row.name, row.value])),
  }, body: JSON.stringify({ jsonrpc: '2.0', id: sequence++, method, ...(params ? { params } : {}) }) });
  if (!response.ok) throw new Error(`Broker HTTP ${response.status}`);
  const data = await response.json(); if (data.error) throw new Error('Broker RPC refused.'); return data.result;
}
const lines = createInterface({ input: process.stdin });
lines.on('line', line => { void (async () => {
  const message = JSON.parse(line), { id, method, params } = message;
  if (method === 'initialize') return reply(id, { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] });
  if (method === 'authenticate' || method === 'session/set_mode' || method === 'session/set_config_option') return reply(id, {});
  if (method === 'session/new' || method === 'session/load') {
    descriptor = params.mcpServers.find(row => row.name === 'memory-proposals');
    if (descriptor) {
      await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fictional-peer', version: '1' } });
      const listed = await rpc('tools/list'); discovery.push(listed.tools.map(tool => tool.name));
    }
    save(); return reply(id, { sessionId: 'fictional-memory-session', modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] } });
  }
  if (method === 'session/prompt') {
    prompts++; const script = JSON.parse(readFileSync(process.env.FAKE_MEMORY_SCRIPT, 'utf8'));
    const result = await rpc('tools/call', { name: script.tool || 'memory_propose', arguments: script.input });
    calls.push({ result, requestId: script.input?.requestId }); save();
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fictional-memory-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: result.isError ? 'The fictional proposal needs attention.' : 'Review the fictional proposal in Bud memory.' } } } }) + '\n');
    return reply(id, { stopReason: 'end_turn' });
  }
  if (id !== undefined) reply(id, {});
})().catch(() => { if (process.env.FAKE_MEMORY_OUTPUT) save(); process.exitCode = 1; lines.close(); process.stdin.destroy(); }); });
