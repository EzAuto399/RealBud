#!/usr/bin/env node
// Jev eval: every Jev use RealBud makes, run on fictional labelled cases through
// the real module code and server/jev-client.ts, graded, then swept offline over
// thresholds. Threshold changes are gated on a live run (docs/QA-LIVE-DEBUG.md).
//
//   node scripts/eval-jev.mjs --arm fake [--seed 1] [--uses w1,w3,ledger,recipe,ask,bills] [--out <dir>]
//   REALBUD_EVAL_MODEL_KEY=… REALBUD_EVAL_MODEL_BASE_URL=https://…/v1 [REALBUD_JEV_MODEL=…] node scripts/eval-jev.mjs --arm live
//
// fake: a local HTTP fake of Modelvia POST /v1/decisions answers from the gold labels, seeded to be mostly right,
//       sometimes confidently wrong and sometimes unsure. It proves the harness and grader, never a model.
// live: the same calls to Modelvia with a capped dev key.
// Both arms call jev-client's own decide (Idempotency-Key, one retry after a retryable 503, strict response checks).
// The grant and key live only in this process (jev-client's in-memory seams); data, logs and HOME are a mkdtemp folder.
// Exit 0 = ran (live: no wrong-accept at current thresholds), 1 = live wrong-accept at current thresholds, 2 = refused or harness error.
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as httpServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pmInboxCases } from './lib/pm-inbox-fixture.mjs';
import { CEILINGS, CHOICE_GRID, LABEL_GRID, ROLES, SCREEN_GRID, accept, choiceLead, percentile, same, sweep } from './lib/eval-jev-grade.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EVAL = join(root, 'scripts/eval-jev');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const refuse = message => { console.error(`eval-jev: ${message}`); process.exit(2); };
const delay = ms => new Promise(r => setTimeout(r, ms));

// ── Flags and refusals (before anything starts or is sent) ──
const argv = process.argv.slice(2);
for (const arg of argv) if (arg.startsWith('--') && !['--arm', '--out', '--uses', '--seed'].includes(arg)) refuse(`Unknown flag ${arg}.`);
const flag = name => { const i = argv.indexOf(name); if (i < 0) return undefined; const v = argv[i + 1]; if (!v || v.startsWith('--')) refuse(`${name} needs a value.`); return v; };
if (Number(process.versions.node.split('.')[0]) < 24) refuse('Use Node 24 or later.');
const arm = flag('--arm') ?? 'fake';
if (!['fake', 'live'].includes(arm)) refuse('--arm must be fake or live.');
const USES = ['w1', 'w3', 'ledger', 'recipe', 'ask', 'bills'];
const uses = flag('--uses')?.split(',').map(s => s.trim()).filter(Boolean) ?? USES;
for (const use of uses) if (!USES.includes(use)) refuse(`Unknown use ${use}. Uses: ${USES.join(', ')}.`);
if (arm === 'live' && argv.includes('--seed')) refuse('--seed is for the fake arm only.');
const seed = flag('--seed') ?? '1';
const live = arm === 'live' ? {
  key: process.env.REALBUD_EVAL_MODEL_KEY || refuse('--arm live needs REALBUD_EVAL_MODEL_KEY (a capped dev Modelvia key). The key is read only from that variable and is never printed or saved. Nothing was sent.'),
  baseUrl: process.env.REALBUD_EVAL_MODEL_BASE_URL || refuse('--arm live needs REALBUD_EVAL_MODEL_BASE_URL (the https Modelvia /v1 endpoint for that key). Nothing was sent.'),
} : null;
if (live && (!/^https:\/\//.test(live.baseUrl) || !URL.canParse(live.baseUrl))) refuse('REALBUD_EVAL_MODEL_BASE_URL must be an https URL. Nothing was sent.');
delete process.env.REALBUD_EVAL_MODEL_KEY; // nothing imported below reads it
const jevModelEnv = process.env.REALBUD_JEV_MODEL?.trim();
if (jevModelEnv === 'off') refuse('REALBUD_JEV_MODEL is off, so jev-client refuses every call. Nothing was sent.');
const MODEL = jevModelEnv || 'jev-1.13-decisions';
// One model for every use: jev-client otherwise picks a primary per use (Luna for w1 and ledger) and falls back to the other.
process.env.REALBUD_JEV_MODEL = MODEL; process.env.REALBUD_JEV_FALLBACK_MODEL ||= 'off';
const secret = live?.key;
const sanitize = value => { const s = String(value ?? ''); return secret ? s.replaceAll(secret, '[redacted]') : s; };

// Data, logs and HOME never resolve under the real office or Hermes folders.
const forbidden = [...new Set(['.realbud', '.hermes'].map(name => join(homedir(), name)).flatMap(p => existsSync(p) ? [p, realpathSync(p)] : [p]))];
const real = p => { let at = resolve(p), rest = ''; while (!existsSync(at) && dirname(at) !== at) { rest = join(at.slice(dirname(at).length + 1), rest); at = dirname(at); } return join(realpathSync(at), rest); };
const guardPath = (label, p) => { const r = real(p); if (forbidden.some(f => r === f || r.startsWith(f + sep) || resolve(p) === f || resolve(p).startsWith(f + sep))) refuse(`${label} resolves under ~/.realbud or ~/.hermes: ${p}. Refusing to touch real office or Hermes data.`); };
guardPath('The scratch folder', tmpdir());
const stamp = new Date();
const out = resolve(flag('--out') ?? join(root, 'outputs', `eval-jev-${stamp.toLocaleDateString('en-CA')}`, `${arm}-${stamp.toTimeString().slice(0, 8).replaceAll(':', '')}`));
guardPath('--out', out);
if (existsSync(out)) refuse(`--out ${out} already exists; earlier evidence is preserved. Choose a new folder.`);

// ── Isolation: set before any server module is imported (they read these at import) ──
const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'realbud-eval-jev-'));
const home = join(scratch, 'home'), data = join(home, 'data');
mkdirSync(data, { recursive: true, mode: 0o700 });
Object.assign(process.env, { HOME: home, USERPROFILE: home, REALBUD_DATA_DIR: data, REALBUD_HERMES_HOME: join(data, 'hermes'), HERMES_HOME: join(data, 'hermes'),
  REALBUD_LOG_DIR: join(scratch, 'logs'), REALBUD_MANAGED_SERVICE: '0', REALBUD_SERVICE_ENTITLEMENT_REQUIRED: '0' });
for (const name of ['REALBUD_DATA_DIR', 'REALBUD_HERMES_HOME', 'REALBUD_LOG_DIR']) guardPath(name, process.env[name]);
// Only Modelvia (live) or loopback (fake arm, the fictional portal) is reachable.
const allowedHosts = new Set(['127.0.0.1', ...(live ? [new URL(live.baseUrl).hostname] : [])]);
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  return allowedHosts.has(url.hostname) ? realFetch(input, init) : Promise.reject(new Error(`eval-jev: outside network refused (${url.origin})`));
};
// jev-client logs one "[jev] ok 40ms" line per call; the report carries those numbers.
const info = console.info.bind(console);
console.info = (...args) => { if (!(typeof args[0] === 'string' && args[0].startsWith('[jev]'))) info(...args); };

// ── The fake Modelvia (fake arm): answers from the gold labels, seeded to be imperfect ──
const FAKE_KEY = `fictional-eval-jev-key-${'f'.repeat(24)}`;
let oracle = null; // (request body) → { [question]: { gold, key } }, set per use
const fakeSeen = { requests: 0, badRequests: 0 };
const unit = key => parseInt(createHash('sha256').update(`${seed}:${key}`).digest('hex').slice(0, 8), 16) / 2 ** 32;
const round = v => Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000;
/** ~72% right and sure, ~10% confidently wrong, the rest unsure (either way). */
function fakeAnswer(question, gold, key) {
  const r = unit(key), r2 = unit(`${key}:2`);
  if (question.type === 'noul') {
    const sure = gold ? 0.9 + 0.099 * r2 : 0.01 + 0.15 * r2, wrong = gold ? 0.05 + 0.2 * r2 : 0.95 + 0.045 * r2;
    return { type: 'noul', noul: round(r < 0.75 ? sure : r < 0.85 ? wrong : 0.4 + 0.5 * r2) };
  }
  const keys = Object.keys(question.criteria), others = keys.filter(k => k !== gold);
  const wrong = others[Math.floor(r2 * others.length)];
  const [choice, confidence, lead] = r < 0.72 ? [gold, 0.9 + 0.099 * r2, 0.5 + 0.45 * r2] : r < 0.82 ? [wrong, 0.9 + 0.08 * r2, 0.35 + 0.5 * r2]
    : [r2 < 0.5 ? gold : wrong, 0.5 + 0.4 * r2, 0.05 + 0.3 * r2];
  const runnerUp = keys.find(k => k !== choice);
  return { type: 'choice', choice, confidence: round(confidence), probabilities: { [choice]: round(confidence), [runnerUp]: round(confidence - lead) } };
}
const fake = arm === 'fake' ? httpServer(async (req, res) => {
  const chunks = []; for await (const part of req) chunks.push(part);
  const raw = Buffer.concat(chunks).toString('utf8');
  fakeSeen.requests++;
  const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.method !== 'POST' || req.url !== '/v1/decisions' || req.headers.authorization !== `Bearer ${FAKE_KEY}` || !req.headers['idempotency-key']) {
    fakeSeen.badRequests++; return reply(400, { error: { code: 'fake_bad_request' } });
  }
  let answers;
  try {
    const body = JSON.parse(raw), golds = oracle(body);
    answers = Object.fromEntries(Object.entries(body.questions).map(([q, question]) => [q, fakeAnswer(question, golds[q].gold, golds[q].key)]));
  } catch { fakeSeen.badRequests++; return reply(400, { error: { code: 'fake_unknown_case' } }); }
  await delay(15 + Math.floor(unit(raw) * 60));
  reply(200, { id: `fake-${fakeSeen.requests}`, model: 'fictional-jev-fake', answers,
    usage: { input_tokens: Math.ceil(Buffer.byteLength(raw) / 4), output_tokens: 12 * Object.keys(answers).length } });
}) : null;
if (fake) await new Promise(r => fake.listen(0, '127.0.0.1', r));
const baseUrl = live ? live.baseUrl : `http://127.0.0.1:${fake.address().port}/v1`;

// ── The real modules, with the grant and key in memory only ──
const mod = name => pathToFileURL(join(root, `${name}.ts`)).href;
const { setWorkerModelGrant } = await import(mod('server/worker-model-access'));
const { setWorkerModelAccessSnapshot } = await import(mod('server/hermes-runtime-env'));
const { MANAGED_MODEL_KEY_ENV } = await import(mod('server/hermes-pack'));
const { managedServiceFailure } = await import(mod('server/managed-service'));
const { decide, jevReady } = await import(mod('server/jev-client'));
setWorkerModelGrant({ state: 'active', baseUrl, keyId: 'fictional-eval-jev-key', spendCapLabel: live ? 'Capped dev key (eval only)' : 'Fictional fake Modelvia' });
setWorkerModelAccessSnapshot({ [MANAGED_MODEL_KEY_ENV]: live ? live.key : FAKE_KEY });
const cleanup = async () => { if (fake) await new Promise(r => fake.close(r)); rmSync(scratch, { recursive: true, force: true }); };
if (managedServiceFailure('reasoning') || !jevReady()) { await cleanup(); refuse('jev-client is not ready in the isolated process (service entitlement or grant). Nothing was sent.'); }

/** decide, recording each call's request, raw answers, size, latency and usage. */
const recorder = calls => async (request, options = {}) => {
  const started = performance.now();
  const result = await decide(request, options);
  calls.push({ bytes: Buffer.byteLength(JSON.stringify({ model: MODEL, state: request.state, questions: request.questions })), questions: Object.keys(request.questions).length,
    ms: Math.round(performance.now() - started), ok: result.ok, reason: result.ok ? null : result.reason, model: result.ok ? result.model : null,
    usage: result.ok ? result.usage ?? null : null, request, answers: result.ok ? result.answers : null });
  return result;
};
const choiceRecord = (id, gold, answer, valueOf, allowed = true) => answer?.type === 'choice'
  ? { kind: 'choice', id, gold, answered: true, value: valueOf(answer.choice), confidence: answer.confidence ?? null, lead: choiceLead(answer), allowed, choice: answer.choice, probabilities: answer.probabilities ?? null }
  : { kind: 'choice', id, gold, answered: false, value: null, confidence: null, lead: null, allowed };

// ── Uses. Each returns records (one per case), the module's own outcome per case, calls and unasked case ids ──
const seedJson = read(join(root, 'pack/workflows/austin-showcase/fixtures/seed.json'));
const USE = {
  w1: { title: 'W1 payer → tenant hint', where: 'server/bank-reference-match.ts jevPayerHints', current: { conf: 0.9, margin: 0.3 }, grid: CHOICE_GRID,
    async run() {
      const { createBankReferenceBatch } = await import(mod('server/bank-reference'));
      const { bankFirstPass, jevPayerHints } = await import(mod('server/bank-reference-match'));
      const fx = read(join(EVAL, 'w1-payers.json'));
      const rules = [...seedJson.properties.map(p => ({ propertyId: p.code, reference: p.tenant.reiTenantRef, aliases: [], tenant: p.tenant.name })), ...fx.tenants.map(t => ({ aliases: [], ...t }))];
      const byTenant = new Map(rules.map(rule => [rule.tenant, rule.propertyId]));
      const byPayer = new Map(fx.cases.map(c => [c.payer, c]));
      oracle = body => Object.fromEntries(Object.entries(body.questions).map(([q, question]) => {
        const c = byPayer.get(body.state[q].payer), keys = Object.keys(question.criteria);
        return [q, { gold: c.gold === 'none' ? 'none' : keys.find(k => byTenant.get(question.criteria[k].split('; ')[0]) === c.gold), key: `w1:${c.id}` }];
      }));
      const csv = fx.cases.map(c => `03/10/2026,"${fx.amount}",PAYMENT FROM ${c.payer}    RENT,,,,,`).join('\n') + '\n';
      const batch = createBankReferenceBatch({ source: { filename: 'fictional-eval-jev.csv', bytesBase64: Buffer.from(csv).toString('base64') },
        columns: { date: '', amount: '', narrative: '', reference: '' }, dateFormat: 'YYYY-MM-DD', rules });
      const pass = bankFirstPass(batch), calls = [];
      if (pass?.rows.length !== fx.cases.length) throw new Error(`The fictional bank file parsed to ${pass?.rows.length} rows, not ${fx.cases.length}.`);
      await jevPayerHints(batch, pass, recorder(calls));
      const asked = new Map();
      for (const call of calls) for (const [q, question] of Object.entries(call.request.questions)) asked.set(call.request.state[q].payer, { answer: call.answers?.[q], criteria: question.criteria });
      const records = [], module = [], unasked = [];
      fx.cases.forEach((c, i) => {
        const got = asked.get(c.payer);
        if (!got) return unasked.push(c.id);
        records.push(choiceRecord(c.id, c.gold === 'none' ? null : c.gold, got.answer, choice => choice === 'none' ? null : byTenant.get(got.criteria[choice]?.split('; ')[0]) ?? null));
        module.push(pass.rows[i].hintSource === 'jev' ? pass.rows[i].propertyId : null);
      });
      return { records, module, calls, unasked };
    } },
  w3: { title: 'W3 inbound mail noise screen', where: 'server/morning-mail-workflow.ts screenMailNoise', grid: SCREEN_GRID,
    async run() {
      const { screenMailNoise, SCREEN_BULK_MIN, SCREEN_ACTION_MAX } = await import(mod('server/morning-mail-workflow'));
      this.current = { bulk: SCREEN_BULK_MIN, action: SCREEN_ACTION_MAX };
      const fx = read(join(EVAL, 'w3-mail.json'));
      const pm = pmInboxCases(Array.from({ length: 10 }, (_, i) => `EVAL-JEV-MAIL-${String(i + 1).padStart(2, '0')}`))
        .map((mail, i) => ({ id: `w3-pm-inbox-${String(i + 1).padStart(2, '0')}`, noise: fx.pmInboxNoise[i], ...mail }));
      const cases = [...pm, ...fx.cases];
      const bySubject = new Map(cases.map(c => [c.subject.slice(0, 200), c]));
      if (bySubject.size !== cases.length) throw new Error('Two W3 cases share a subject.');
      // Two questions per thread ("t0.bulk", "t0.asks_action"): bulk gold is the noise label, asks_action gold its opposite.
      oracle = body => Object.fromEntries(Object.keys(body.questions).map(q => { const [t, kind] = q.split('.'), c = bySubject.get(body.state[t].subject);
        return [q, { gold: kind === 'bulk' ? c.noise : !c.noise, key: `w3:${c.id}:${kind}` }]; }));
      const threads = cases.map((c, i) => ({ id: c.id, historyComplete: true, messages: [{ id: `${c.id}-1`, threadId: c.id, at: Date.UTC(2026, 9, 7, 21, i), direction: 'incoming',
        from: c.from, to: 'office@fictional-realty.example.invalid', subject: c.subject, body: c.body, bodyTruncated: false, attachments: [] }] }));
      const calls = [];
      const result = await screenMailNoise(threads, { decide: recorder(calls), known: () => false });
      const asked = new Map();
      for (const call of calls) for (const t of Object.keys(call.request.state)) asked.set(call.request.state[t].subject, { bulk: call.answers?.[`${t}.bulk`], action: call.answers?.[`${t}.asks_action`] });
      const records = [], module = [], unasked = [];
      for (const c of cases) {
        if (!asked.has(c.subject.slice(0, 200))) { unasked.push(c.id); continue; }
        const answer = asked.get(c.subject.slice(0, 200));
        const answered = answer.bulk?.type === 'noul' && answer.action?.type === 'noul';
        records.push({ kind: 'screen', id: c.id, gold: c.noise, answered, bulk: answered ? answer.bulk.noul : null, action: answered ? answer.action.noul : null });
        module.push(result?.noise.includes(c.id) ? true : null);
      }
      return { records, module, calls, unasked };
    } },
  ledger: { title: 'Ledger column naming', where: 'server/import-inspect.ts jevMapping', current: { conf: 0.9, margin: 0.3 }, grid: CHOICE_GRID,
    async run() {
      const { jevMapping } = await import(mod('server/import-inspect'));
      const fx = read(join(EVAL, 'ledger-headers.json'));
      const cases = fx.cases.map(c => c.headersFrom ? { ...c, headers: readFileSync(join(root, c.headersFrom), 'utf8').split('\n')[0].trim().split(',') } : c);
      const byHeaders = new Map(cases.map(c => [JSON.stringify(c.headers), c]));
      oracle = body => {
        const c = byHeaders.get(JSON.stringify(body.state.headers));
        return Object.fromEntries(Object.entries(body.questions).map(([role, question]) => [role, {
          gold: c.gold[role] === null ? 'none' : Object.keys(question.criteria).find(k => question.criteria[k] === c.gold[role]), key: `ledger:${c.id}:${role}` }]));
      };
      const calls = [], records = [], module = [], unasked = [];
      for (const c of cases) {
        const before = calls.length;
        const mapping = await jevMapping(c.headers, recorder(calls));
        const call = calls.length > before ? calls.at(-1) : null;
        if (!call) { unasked.push(c.id); continue; }
        const roles = Object.fromEntries(ROLES.map(role => {
          const answer = call.answers?.[role];
          return [role, answer?.type === 'choice' ? { value: /^h\d+$/.test(answer.choice) ? call.request.questions[role].criteria[answer.choice] ?? null : null,
            confidence: answer.confidence ?? null, lead: choiceLead(answer), choice: answer.choice, probabilities: answer.probabilities ?? null } : null];
        }));
        const gold = ROLES.every(role => c.gold[role] !== null) ? Object.fromEntries(ROLES.map(role => [role, c.gold[role]])) : null;
        records.push({ kind: 'mapping', id: c.id, gold, answered: call.ok, roles });
        module.push(mapping);
      }
      return { records, module, calls, unasked };
    } },
  recipe: { title: 'Recipe drifted-control chooser', where: 'server/portal-recipe-runner.ts choose', current: { conf: 0.95, margin: 0.3 }, grid: CHOICE_GRID,
    async run() {
      const { BrowserRuntime, browserTaskWorkroom } = await import(mod('server/browser-runtime'));
      const { BrowserApprovalStore } = await import(mod('server/browser-authority'));
      const { ConnectedAppOperationStore } = await import(mod('server/connected-app-operations'));
      const { portalRecipeGrantNeeds, runPortalRecipes } = await import(mod('server/portal-recipe-runner'));
      const { FICTIONAL_BUSINESS, FICTIONAL_REICID, fictionalReiPack, fictionalReiPortal } = await import(mod('server/testing/fictional-rei-portal'));
      const { parseBrowserTaskGrant } = await import(mod('shared/browser-task'));
      const fx = read(join(EVAL, 'recipe-controls.json'));
      const pack = fictionalReiPack();
      if (!pack.recipes['find-record'].steps.some(step => step.type?.field === fx.wanted)) throw new Error(`find-record no longer types into "${fx.wanted}".`);
      const runs = [{ recipe: 'open-session' }, { recipe: 'find-record', inputs: { list: 'Owners', query: 'Two' } }];
      const SENTINEL = 'EVAL-JEV-SEARCH-BOX';
      let current = null;
      oracle = body => { const at = current.gold === null ? -1 : body.state.candidates.findIndex(c => c.name === current.gold); return { control: { gold: at < 0 ? 'none' : `c${at}`, key: `recipe:${current.id}` } }; };
      const sha256 = text => createHash('sha256').update(text).digest('hex');
      const calls = [], records = [], module = [], unasked = [], unsafe = [];
      for (const c of fx.cases) {
        current = c;
        const dir = mkdtempSync(join(scratch, 'recipe-'));
        const mock = fictionalReiPortal({ searchLabel: SENTINEL });
        // The Owners page's Search box becomes the case's textboxes; '*' keeps the real box (its ref) under a new label.
        const line = new RegExp(`^( +)(@e\\d+) textbox "${SENTINEL}" (value="[^"]*")$`, 'm');
        const command = async (args, signal) => {
          const reply = await mock.command(args, signal);
          return args[0] === 'observe' && typeof reply.text === 'string' ? { ...reply, text: reply.text.replace(line, (_, pad, ref, value) =>
            c.page.map((label, n) => label.startsWith('*') ? `${pad}${ref} textbox ${JSON.stringify(label.slice(1))} ${value}` : `${pad}@e${900 + n} textbox ${JSON.stringify(label)} value=""`).join('\n')) } : reply;
        };
        const runtime = new BrowserRuntime({ root: dir, command, executable: async () => '/synthetic/bsk', startDaemon: async () => {} });
        await runtime.connect(); await runtime.select('work');
        const grantId = `grant-${randomUUID()}`, needs = portalRecipeGrantNeeds(pack, runs), text = 'Fictional eval-jev task: find-record';
        const grant = parseBrowserTaskGrant({ version: 1, purpose: 'browser-task-grant', id: grantId, runId: `run-${randomUUID()}`, route: 'ask', request: { text, sha256: sha256(text) },
          sites: needs.sites, browser: { id: null, accountMarker: FICTIONAL_BUSINESS }, actions: needs.actions, consequential: 'ask-each', uploads: [], expiresAt: null, budget: null });
        const before = calls.length;
        // The person refuses every ask: a pick is recorded, never typed.
        const run = await runPortalRecipes({ pack, runs, grant, runtime, workroom: browserTaskWorkroom(dir, grantId), threadId: 'thread-fictional-eval-jev', approve: async () => false,
          operations: new ConnectedAppOperationStore({ file: join(dir, 'operations.json') }), approvals: new BrowserApprovalStore({ file: join(dir, 'approvals.json') }),
          account: { urlValue: FICTIONAL_REICID, marker: FICTIONAL_BUSINESS }, rules: () => [], assertCapability: () => {}, pollMs: 0, chooser: recorder(calls) });
        if (mock.effects.length || mock.calls.some(args => args[0] === 'fill')) unsafe.push(`${c.id}: the portal saw ${mock.effects.length ? 'an effect' : 'typing'} although the person refused every ask`);
        const step = run.receipt.steps.find(item => item.chooser), call = calls.length > before ? calls.at(-1) : null;
        if (!step || !call) { unasked.push(c.id); continue; }
        const { candidates, outcome, pick } = step.chooser;
        const nameOf = choice => { const m = /^c(\d{1,2})$/.exec(choice ?? ''); return m && candidates[Number(m[1])] ? candidates[Number(m[1])].name : null; };
        // The guard is known only for a pick that cleared the threshold; otherwise the sweep assumes it allows (conservative).
        records.push({ ...choiceRecord(c.id, c.gold, call.answers?.control, nameOf, outcome !== 'refused-by-guard'), outcome });
        module.push(outcome === 'picked' ? nameOf(pick) : null);
      }
      return { records, module, calls, unasked, unsafe };
    } },
  ask: { title: 'Ask pre-route', where: 'server/ask-jev-route.ts askJevRoute → chooseAskRoute', grid: CHOICE_GRID,
    async run() {
      const { askJevRoute, ASK_JEV_MIN_CONFIDENCE, ASK_JEV_MIN_MARGIN } = await import(mod('server/ask-jev-route'));
      this.current = { conf: ASK_JEV_MIN_CONFIDENCE, margin: ASK_JEV_MIN_MARGIN };
      const fx = read(join(EVAL, 'ask-route.json'));
      const byText = new Map(fx.cases.map(c => [c.text, c]));
      oracle = body => ({ route: { gold: byText.get(body.state).gold ?? 'bud', key: `ask:${byText.get(body.state).id}` } });
      const calls = [], records = [], module = [], unasked = [];
      // Through the Ask seam, so a case a regex control already answers is reported as never asked.
      for (const c of fx.cases) {
        const before = calls.length;
        const route = await askJevRoute(c.text, { person: true, ready: () => true, decide: recorder(calls) });
        const call = calls.length > before ? calls.at(-1) : null;
        if (!call) { unasked.push(c.id); continue; }
        records.push(choiceRecord(c.id, c.gold, call.answers?.route, choice => choice === 'bud' ? null : choice));
        module.push(route);
      }
      return { records, module, calls, unasked };
    } },
  bills: { title: 'Duplicate bill labels and ranking', where: 'server/source-bills.ts rankDuplicateCandidates', current: { same: 0.9, different: 0.1 }, grid: LABEL_GRID,
    async run() {
      const { rankDuplicateCandidates } = await import(mod('server/source-bills'));
      const fx = read(join(EVAL, 'bill-pairs.json'));
      const facts = changes => ({ ...fx.base, ...changes });
      const groups = [...fx.pairs.map((pair, n) => ({ id: `bills-pair-${String(n + 1).padStart(2, '0')}`, bill: pair.bill, candidates: [{ name: pair.name, facts: pair.candidate, same: pair.same }] })), ...fx.groups];
      let current = null;
      oracle = body => Object.fromEntries(Object.keys(body.questions).map(q => { const n = Number(q.slice(1)); return [q, { gold: current.candidates[n].same, key: `bills:${current.id}:${n}` }]; }));
      const calls = [], records = [], module = [], unasked = [], ranking = [];
      for (const group of groups) {
        current = group;
        const candidates = group.candidates.map((item, n) => ({ billId: `source-bill:${createHash('sha256').update(`${group.id}:${n}`).digest('hex')}`, revision: 1, matchedRevision: 1,
          sourceDigest: 'd'.repeat(64), facts: facts(item.facts), subject: 'Fictional subject', receivedAt: 1, match: 'invoice-identity' }));
        const before = calls.length;
        const ranked = await rankDuplicateCandidates({ version: 1, sourceDigest: 'a'.repeat(64), reviewDigest: 'b'.repeat(64), candidates, complete: true }, facts(group.bill), recorder(calls));
        const call = calls.length > before ? calls.at(-1) : null;
        if (!call) { unasked.push(group.id); continue; }
        group.candidates.forEach((item, n) => {
          const answer = call.answers?.[`c${n}`];
          records.push({ kind: 'label', id: `${group.id}:${item.name}`, gold: item.same, answered: answer?.type === 'noul', noul: answer?.type === 'noul' ? answer.noul : null });
          module.push(ranked.candidates.find(candidate => candidate.billId === candidates[n].billId)?.likely ?? null);
        });
        // Ranking: with several candidates and a true duplicate among them, is one ranked first (fixtures never list it first)?
        if (group.candidates.length > 1 && group.candidates.some(item => item.same))
          ranking.push({ id: group.id, first: group.candidates[candidates.findIndex(candidate => candidate.billId === ranked.candidates[0].billId)].same, todayFirst: group.candidates[0].same });
      }
      const first = ranking.filter(r => r.first).length;
      return { records, module, calls, unasked, extra: { ranking, line: `Ranking: a true duplicate first in ${first} of ${ranking.length} groups with several candidates (today's order: ${ranking.filter(r => r.todayFirst).length} of ${ranking.length}).` } };
    } },
};

// ── Run, grade, sweep ──
const results = { version: 1, arm, model: MODEL, seed: arm === 'fake' ? seed : null, startedAt: stamp.toISOString(), node: process.version, platform: process.platform, uses: {} };
const problems = [];
try {
  for (const name of uses) {
    const use = USE[name];
    console.log(`${use.title} …`);
    const { records, module, calls, unasked, unsafe = [], extra = null } = await use.run();
    const mismatched = records.filter((record, i) => !same(accept(record, use.current), module[i])).map(r => r.id);
    if (unasked.length) problems.push(`${name}: never asked about ${unasked.join(', ')}`);
    if (mismatched.length) problems.push(`${name}: the grader's replay at current thresholds disagrees with the module for ${mismatched.join(', ')} (did a threshold in source change?)`);
    problems.push(...unsafe.map(line => `${name}: ${line}`));
    const failed = calls.filter(call => !call.ok);
    if (failed.length) problems.push(`${name}: ${failed.length} of ${calls.length} calls failed (${[...new Set(failed.map(call => call.reason))].join(', ')})`);
    const usage = calls.filter(call => call.usage), ms = calls.map(call => call.ms);
    results.uses[name] = { title: use.title, where: use.where, current: use.current, sweep: sweep(records, use.grid, use.current),
      calls: { count: calls.length, failed: failed.length, reasons: Object.fromEntries([...new Set(failed.map(call => call.reason))].map(r => [r, failed.filter(call => call.reason === r).length])),
        p50Ms: percentile(ms, 50), p95Ms: percentile(ms, 95), questionsPerCall: calls.length ? calls.reduce((s, call) => s + call.questions, 0) / calls.length : null,
        meanRequestBytes: calls.length ? Math.round(calls.reduce((s, call) => s + call.bytes, 0) / calls.length) : null, maxRequestBytes: calls.length ? Math.max(...calls.map(call => call.bytes)) : null,
        inputTokens: usage.length ? usage.reduce((s, call) => s + call.usage.input_tokens, 0) : null, outputTokens: usage.length ? usage.reduce((s, call) => s + call.usage.output_tokens, 0) : null,
        models: [...new Set(calls.map(call => call.model).filter(Boolean))] },
      selfCheck: { cases: records.length, agree: records.length - mismatched.length }, extra,
      records, rawCalls: calls };
  }
  if (fake && (fakeSeen.badRequests || fakeSeen.requests !== Object.values(results.uses).reduce((s, u) => s + u.calls.count, 0))) problems.push(`fake Modelvia: ${fakeSeen.requests} requests, ${fakeSeen.badRequests} without the expected path, key or Idempotency-Key, or unknown`);
} catch (error) {
  problems.push(`harness: ${sanitize(error instanceof Error ? error.stack ?? error.message : error).slice(0, 1200)}`);
} finally { await cleanup(); }

const git = args => { try { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim(); } catch { return null; } };
const liveWrong = arm === 'live' ? Object.entries(results.uses).filter(([, u]) => u.sweep.current.wrongAccepts > 0).map(([name]) => name) : [];
Object.assign(results, { finishedAt: new Date().toISOString(), source: { head: git(['rev-parse', 'HEAD']), uncommittedEntries: git(['status', '--porcelain'])?.split('\n').filter(Boolean).length ?? null },
  layer: arm === 'fake' ? 'Local tests: real module code and jev-client against a seeded local fake of Modelvia /v1/decisions (the control arm).' : `Live integration: real module code and jev-client against Modelvia (${MODEL}) with a capped dev key.`,
  limits: [
    ...(arm === 'fake' ? ['FAKE ARM: the answers are seeded from the gold labels to be imperfect on purpose. This proves the harness, grader and sweep, never the model; do not move a threshold on it.'] : ['One live run; small case sets: a sweep point is a lower bound on risk, not a guarantee. Rerun before and after any threshold change.']),
    'Every case is fictional (names, addresses, mail, headers, portal); none is customer or REI evidence.',
    'Recipe chooser: the guard (stop labels) is known only for picks that cleared the current threshold; elsewhere the sweep assumes the guard allows, which can only overstate wrong-accepts.',
    'Wrong-accept ≤ 1% is 1% of the cases, rounded down: 0 below 100 cases.',
    'Source code only: no packaged, installed or Windows evidence.'],
  problems, liveWrongAtCurrent: liveWrong, exit: problems.length ? 2 : liveWrong.length ? 1 : 0 });
mkdirSync(out, { recursive: true, mode: 0o700 });
writeFileSync(join(out, 'results.json'), sanitize(JSON.stringify(results, null, 2)) + '\n', { mode: 0o600 });

// ── Report ──
const pct = v => v === null || v === undefined ? '' : `${Math.round(v * 1000) / 10}%`;
const cell = v => v === null || v === undefined ? '' : String(v);
const th = t => t ? Object.entries(t).map(([k, v]) => `${k} ${CEILINGS.includes(k) ? '≤' : '≥'} ${v}`).join(', ') : 'none qualifies';
const md = [
  `# Jev eval: ${arm} arm`, '',
  `${results.startedAt} · source ${results.source.head?.slice(0, 12) ?? 'unknown'} (${results.source.uncommittedEntries ?? '?'} uncommitted entries) · Node ${process.version} · model ${MODEL}${arm === 'fake' ? ` · seed ${seed}` : ''}`, '',
  `Evidence tier: ${results.layer}`, '',
  ...(arm === 'fake' ? ['> **Fake arm.** Answers come from a seeded fake that is right most of the time, confidently wrong sometimes and unsure sometimes. It proves the harness, grader and sweep, not the model. Thresholds change only on a live run.', ''] : []),
  '## Summary at current thresholds', '',
  '| Use | Cases | Accuracy (raw) | Coverage | Wrong-accepts | Fallback | Errors | p50 ms | p95 ms | Calls | Tokens in / out | Self-check |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ...Object.entries(results.uses).map(([name, u]) => { const s = u.sweep.current; return `| ${name} | ${s.cases} | ${pct(s.accuracy)} | ${pct(s.coverage)} | **${s.wrongAccepts}** | ${pct(s.fallbackRate)} | ${s.errors} | ${cell(u.calls.p50Ms)} | ${cell(u.calls.p95Ms)} | ${u.calls.count} | ${cell(u.calls.inputTokens)} / ${cell(u.calls.outputTokens)} | ${u.selfCheck.agree}/${u.selfCheck.cases} |`; }), '',
  'Accuracy is the model\'s own top answer against the label, thresholds aside. Coverage is accepted / cases; a wrong-accept is accepted but wrong (the safety metric); fallback is not accepted (no hint, Bud asked, thread kept). Self-check: the grader\'s replay of each module\'s rule at current thresholds agrees with what the module did.', '',
  ...Object.entries(results.uses).flatMap(([name, u]) => [
    `## ${u.title} (\`${name}\`)`, '', `\`${u.where}\` · ${u.calls.count} calls · ${cell(u.calls.questionsPerCall?.toFixed(1))} questions per call · request ${cell(u.calls.meanRequestBytes)} B mean, ${cell(u.calls.maxRequestBytes)} B max · answered by ${u.calls.models.join(', ') || 'nothing'}`, '',
    '| Setting | Thresholds | Coverage | Correct accepts | Wrong-accepts |', '| --- | --- | --- | --- | --- |',
    ...[['Current', u.sweep.current], ['Max coverage, wrong-accept = 0', u.sweep.zeroWrong], ['Max coverage, wrong-accept ≤ 1%', u.sweep.onePercent]].map(([label, s]) =>
      s ? `| ${label} | ${th(s.thresholds)} | ${pct(s.coverage)} | ${s.correctAccepts} | ${s.wrongAccepts} |` : `| ${label} | none on the grid | | | |`), '',
    `Wrong-accepts at current thresholds: ${u.sweep.current.wrong.join(', ') || 'none'}.`, '', ...(u.extra?.line ? [u.extra.line, ''] : [])]),
  '## Problems', '', ...(problems.length ? problems.map(p => `- ${p}`) : ['None.']), '',
  '## Limits', '', ...results.limits.map(l => `- ${l}`), '',
];
writeFileSync(join(out, 'report.md'), sanitize(md.join('\n')), { mode: 0o600 });
for (const [name, u] of Object.entries(results.uses)) {
  const s = u.sweep.current, z = u.sweep.zeroWrong;
  console.log(`${name.padEnd(7)} cases ${s.cases} · coverage ${pct(s.coverage)} · wrong-accepts ${s.wrongAccepts} · p95 ${u.calls.p95Ms} ms · current ${th(u.current)} → best at 0 wrong ${th(z?.thresholds)} (${pct(z?.coverage)})`);
}
for (const p of problems) console.error(`PROBLEM ${sanitize(p)}`);
console.log(`${results.exit === 0 ? 'OK' : results.exit === 1 ? 'FAIL (live wrong-accept at current thresholds)' : 'HARNESS ERROR'} · ${join(out, 'report.md')}`);
process.exitCode = results.exit;
