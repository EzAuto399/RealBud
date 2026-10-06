// FICTIONAL demo worker for the Austin showcase. Never calls a model.
// scripts/seed-austin-demo.mjs copies this file into the demo scratch folder
// behind a generated header that defines DATA (the demo data dir) and CHANGE
// (the scripted rule change from fixtures/seed.json), then runs it as Bud's CLI.
//   one-shot (workflow runs): answers the host-written workflow input that was
//     written last (inbox triage or invoice preparation) from its own text.
//   `acp` (Ask): a scripted ACP peer. When the person asks to change the
//     maintenance comparison basis it calls workflow_settings_propose, so
//     RealBud shows its real approval card; anything else gets a plain note.
// Adapted from scripts/qa-morning-mail.mjs, qa-w2-calendar.mjs and
// server/testing/memory-proposal-acp-cli.mjs.
/* global DATA, CHANGE */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

if (process.argv.includes('--version')) { console.log('Hermes Agent v0.21.3 (2026.9.14)'); process.exit(0); }
const calls = join(DATA, 'vault', 'bud-work', 'worker-calls.json');
const log = entry => { let list = []; try { list = JSON.parse(readFileSync(calls, 'utf8')); } catch {} list.push({ at: Date.now(), ...entry }); try { writeFileSync(calls, JSON.stringify(list)); } catch {} };

if (process.argv.includes('acp')) {
  let settings = null, sequence = 1;
  const out = value => process.stdout.write(JSON.stringify(value) + '\n');
  const say = (sessionId, text) => out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
  const rpc = async (method, params) => {
    const response = await fetch(settings.url, { method: 'POST', signal: AbortSignal.timeout(15 * 60_000), headers: { 'content-type': 'application/json', ...Object.fromEntries(settings.headers.map(h => [h.name, h.value])) },
      body: JSON.stringify({ jsonrpc: '2.0', id: sequence++, method, ...(params ? { params } : {}) }) });
    const data = await response.json(); if (data.error) throw new Error('The working-rules tool refused the call.'); return data.result;
  };
  const lines = createInterface({ input: process.stdin });
  lines.on('line', line => { void (async () => {
    const { id, method, params } = JSON.parse(line);
    if (method === 'initialize') return out({ jsonrpc: '2.0', id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } });
    if (method === 'session/new' || method === 'session/load') {
      settings = (params?.mcpServers ?? []).find(s => s.name === 'workflow-settings' && typeof s.url === 'string') ?? null;
      return out({ jsonrpc: '2.0', id, result: { sessionId: 'fictional-demo-session', modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] } } });
    }
    if (method === 'session/prompt') {
      const sessionId = params?.sessionId ?? 'fictional-demo-session';
      const text = JSON.stringify(params?.prompt ?? []);
      if (!/received|arriv/i.test(text) || !settings) {
        say(sessionId, settings ? 'This is the fictional demo worker. In this sample it can only change how maintenance invoices are compared (try: "compare maintenance invoices by the date we received them").' : 'Working rules are not available in this chat.');
        return out({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
      }
      await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fictional-demo-worker', version: '1' } });
      const result = await rpc('tools/call', { name: 'workflow_settings_propose', arguments: { target: CHANGE.target, values: CHANGE.values, reason: CHANGE.reason } });
      const reply = String(result?.content?.[0]?.text ?? '');
      log({ kind: 'rule-change', isError: Boolean(result?.isError) });
      say(sessionId, result?.isError ? `Nothing was changed: ${reply}` : `Done. ${reply}`);
      return out({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
    }
    if (id !== undefined) out({ jsonrpc: '2.0', id, result: {} });
  })().catch(() => { process.exitCode = 1; lines.close(); }); });
} else {
  const answer = result => console.log(JSON.stringify({ summary: 'Fictional deterministic preparation', evidence: ['Fictional demo sources'], outputs: [JSON.stringify(result)], needsApproval: [] }));
  const dir = join(DATA, 'vault', 'workflow-inputs');
  const latest = ['accounts-inbox.json', 'accounts-invoices.json'].filter(n => existsSync(join(dir, n))).sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs)[0];
  if (!latest) { console.log('{}'); process.exit(0); }
  const input = JSON.parse(readFileSync(join(dir, latest), 'utf8'));
  if (latest === 'accounts-inbox.json') {
    log({ kind: 'inbox', count: input.threads.length });
    answer({ version: 1, kind: 'accounts-inbox-triage', skillSource: 'email-inbox-triage@0.1.0', sourceReference: input.sourceReference, status: 'complete', coverageComplete: true, holds: [], actionsPerformed: [],
      threads: input.threads.map(t => { const text = JSON.stringify(t), code = (text.match(/SYN-P0[1-6]/) ?? ['no property'])[0];
        return { threadId: t.threadId, disposition: /invoice|rates bill/i.test(text) ? 'reference' : 'action-review', owner: 'property-manager', priority: /leak|smoke alarm/i.test(text) ? 'high' : 'normal',
          sourceMessageIds: t.messages.map(m => m.messageId), reason: `Fictional source names ${code}.`, nextAction: 'Review internally; no external action was taken.', missingFacts: [] }; }) });
  } else {
    const doc = input.documents[0], text = `${doc.subject}\n${doc.body}`, pick = re => (text.match(re) ?? [])[1] ?? null;
    const property = input.propertyMap.find(p => text.includes(p.reference)); log({ kind: 'invoice', count: 1 });
    answer({ version: 1, kind: 'accounts-invoice-entry-review', sourceReference: input.sourceReference, status: 'partial', coverageComplete: false, holds: [{ itemId: 'coverage', reason: 'Only the selected fictional message is available.' }], actionsPerformed: [],
      documents: [{ documentId: doc.documentId, decision: 'hold', duplicateOf: null, conflictGroup: null,
        proposedEntry: { supplierId: pick(/Supplier: ([^.]+)\./), invoiceId: pick(/Invoice number (\S+)\./), propertyId: property?.propertyId ?? null, amount: pick(/AUD ([0-9.]+)\./), currency: 'AUD', dueDate: pick(/Due (\d{4}-\d{2}-\d{2})/), costType: pick(/Kind: ([^.]+)\./) },
        sourceIds: [doc.sourceId], reason: 'Fictional source text supplies candidate facts; staff approval remains required.' }] });
  }
}
