#!/usr/bin/env node
// Two desktops, one customer pack round trip: office A installs the Auston
// office pack and Sherry's role pack, makes one read plan and has one published
// watch-and-learn recipe, then exports; office B (a fresh data folder) previews,
// imports, re-imports, upgrades, rolls back, and refuses tampered packs.
//
// Each office is the real local service (server/index.ts) on loopback with its
// own scratch HOME and REALBUD_DATA_DIR, never ~/.realbud. A loopback lab
// website stands in for realbud.app. No network, account, model or REI access.
//
// The service trusts only the pinned RealBud publisher key, whose private half
// is held offline. So office A's export is signed here with a fictional key made
// in memory, and the signed preview, install, re-import and upgrade run through
// the same pack service on office B's data folder while B's service is stopped
// (trustedKeys: that fictional key). B's HTTP routes then read the result after a
// restart, and the rollback runs over HTTP.
//   node scripts/qa-pack-roundtrip.mjs   (Node 24+; QA_OUTPUT optional, must be fresh)
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSessionToken } from './local-session.mjs';
import { CHANGED_PACK_MESSAGE, publicKeyEntry, signPack, verifyPackSignature } from '../server/pack-signing.ts';

if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Use Node 24 or later.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.env.QA_OUTPUT ?? join(root, `outputs/pack-roundtrip-${new Date().toISOString().slice(0, 10)}`));
assert.ok(!existsSync(output), `Choose a fresh QA_OUTPUT; ${output} exists and earlier evidence is preserved.`);
mkdirSync(output, { recursive: true });
const temp = mkdtempSync(join(realpathSync(tmpdir()), 'rb-pack-roundtrip-'));
const office = name => {
  const home = join(temp, name), data = join(home, 'data');
  mkdirSync(data, { recursive: true, mode: 0o700 });
  assert.notEqual(realpathSync(data), resolve(homedir(), '.realbud'), 'Never point a QA run at the real ~/.realbud');
  return { name, home, data, profile: join(data, 'hermes/profiles/property'), vault: join(data, 'vault') };
};
const A = office('office-a'), B = office('office-b');
// The in-process pack service reads plans from DATA_DIR at import: office B's.
Object.assign(process.env, { HOME: B.home, USERPROFILE: B.home, REALBUD_DATA_DIR: B.data, REALBUD_HERMES_HOME: join(B.data, 'hermes') });
const { createCustomerPackService, validateCustomerPack } = await import('../server/customer-packs.ts');
const { loadRecipes } = await import('../server/recipes.ts');

const sha = text => createHash('sha256').update(text).digest('hex');
const read = path => existsSync(path) ? readFileSync(path, 'utf8') : null;
const clone = value => JSON.parse(JSON.stringify(value));
const wait = ms => new Promise(r => setTimeout(r, ms));
const results = [], gaps = [];
const check = (step, ok, detail = '') => { results.push({ step, ok: Boolean(ok), detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${step}${detail && !ok ? ` — ${detail}` : ''}`); };
const gap = (step, detail) => { gaps.push({ step, detail }); console.log(`GAP  ${step} — ${detail}`); };
/** A refusal a person can read: 4xx, one short sentence, no stack, path or JSON. */
const plain = (reply, pattern) => reply.status === 400 && typeof reply.body.error === 'string' && reply.body.error.length < 200 &&
  !/\/(?:Users|home|private|var)\/|[A-Za-z]:\\|\bat \w|Error:|[{}]/.test(reply.body.error) && (!pattern || pattern.test(reply.body.error));

// ── fictional publisher: a key made in memory, trusted only by the in-process service ──
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const KEY_ID = 'fictional-roundtrip-publisher', FICTIONAL_KEYS = [publicKeyEntry(KEY_ID, publicKey)];
// Signs the validated form, as scripts/sign-pack.mjs does, so admission reproduces the signed bytes.
const sign = pack => signPack(validateCustomerPack(clone(pack)), privateKey, KEY_ID);
/** The publisher's own tool, scripts/sign-pack.mjs, given the fictional key in its environment only (never on disk). */
const signWithTool = file => {
  const signer = spawnSync(process.execPath, [join(root, 'scripts/sign-pack.mjs'), '--key-id', KEY_ID, file], { cwd: root, encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: join(temp, 'publisher'), REALBUD_DATA_DIR: join(temp, 'publisher/data'), REALBUD_PACK_SIGNING_KEY: privateKey.export({ format: 'pem', type: 'pkcs8' }) } });
  if (signer.status !== 0) throw new Error(`sign-pack.mjs failed: ${signer.stderr}`);
  return JSON.parse(signer.stdout);
};

// ── loopback lab website: link-code redeem and the office's uploaded packs ──
const CODE = `rb1_${'e5'.repeat(32)}`;
let labPacks = [];
const lab = createServer(async (req, res) => {
  let raw = ''; for await (const part of req) raw += part;
  const path = new URL(req.url, 'http://lab').pathname;
  res.setHeader('content-type', 'application/json');
  if (req.method === 'POST' && path === '/api/installations/redeem') {
    const body = JSON.parse(raw);
    if (body.code !== CODE) { res.writeHead(404); res.end('{}'); return; }
    res.end(JSON.stringify({ installationId: body.id, companyId: 'fictional-roundtrip-office', agencyLabel: 'Fictional Round Trip Office' })); return;
  }
  if (req.method === 'GET' && path === '/api/installations/packs') { res.end(JSON.stringify({ version: 1, packs: labPacks })); return; }
  res.end('{}');
});
lab.listen(0, '127.0.0.1'); await once(lab, 'listening');
const labOrigin = `http://127.0.0.1:${lab.address().port}`;

// ── one office service ──
const worker = join(temp, 'worker.mjs');
writeFileSync(worker, `#!${process.execPath}\nconsole.log('Hermes Agent v0.21.3 (2026.9.14)');\n`); chmodSync(worker, 0o755);
const running = new Set();
async function boot(o) {
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(r => probe.close(r));
  let logs = '';
  const child = spawn(process.execPath, [join(root, 'server/index.ts')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: {
    PATH: process.env.PATH, HOME: o.home, USERPROFILE: o.home, REALBUD_DATA_DIR: o.data, REALBUD_HERMES_HOME: join(o.data, 'hermes'),
    REALBUD_HERMES_CLI: worker, OMB_PORT: String(port), OMB_STATIC_DIR: join(temp, 'no-ui'), ELECTRON_RUN_AS_NODE: '1', VITEST: 'true',
    REALBUD_TEST_LAB: '1', REALBUD_WEBSITE_ORIGIN: labOrigin } });
  child.stdout.on('data', b => { logs = (logs + b).slice(-20_000); }); child.stderr.on('data', b => { logs = (logs + b).slice(-20_000); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    if (child.exitCode !== null || i > 300) throw new Error(`${o.name} service did not start: ${logs.slice(-1500)}`);
    if (await fetch(base + '/api/health').then(r => r.ok, () => false)) break;
    await wait(100);
  }
  const token = await readSessionToken(o.data);
  running.add(o);
  o.http = async (method, path, body) => {
    const response = await fetch(base + path, { method, headers: { 'x-realbud-session': token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  o.ok = async (method, path, body) => { const reply = await o.http(method, path, body); assert.ok(reply.status < 300, `${o.name} ${method} ${path}: ${reply.status} ${JSON.stringify(reply.body)}`); return reply.body; };
  o.stop = async () => {
    running.delete(o);
    if (child.exitCode !== null) return;
    const closed = once(child, 'close'); child.kill('SIGTERM');
    await Promise.race([closed, wait(8000).then(() => child.kill('SIGKILL'))]);
  };
}
const recipesOf = async o => (await o.ok('GET', '/api/recipes')).recipes;
const loopsOf = async o => (await o.ok('GET', '/api/loops')).loops;
const unapproved = r => r.status === 'shadow' && r.planApprovedAt === null && r.approvedRevision === null;
const SHERRY_LOOPS = ['maintenance-review', 'rei-supplier-check', 'inspection-draft'];

let exitCode = 0;
try {
  // ════ Office A ════
  // One published watch-and-learn read recipe in A's own data folder (as the fixture does for tests).
  const { createLearnedRecipeStore } = await import('../server/learned-recipes.ts');
  const { parsePortalRecipePack } = await import('../server/portal-recipe.ts');
  const shippedRei = parsePortalRecipePack(JSON.parse(readFileSync(join(root, 'pack/workflows/austin-accounts/support/rei-cloud-navigation/recipes.json'), 'utf8')));
  const learnedStore = createLearnedRecipeStore(join(A.data, 'learned-recipes.json'));
  const draft = await learnedStore.create({ portal: 'rei-cloud', title: 'Fictional round trip read', steps: [{ click: 'Show fictional detail' }, { read: 'controls' }], stopBefore: [], flags: [] });
  const confirmed = await learnedStore.update(draft.id, draft.revision, { confirmedLabels: ['Show fictional detail'] }, shippedRei.labels);
  const learned = await learnedStore.publish(confirmed.id, confirmed.revision, shippedRei);
  check('A: one watch-and-learn read recipe published', learned.state === 'published');

  await boot(A);
  for (const id of ['austin-office', 'austin-property']) {
    const pack = await A.ok('GET', `/api/customer-packs/${id}/export`);
    const before = read(join(A.data, 'recipes.json'));
    const preview = await A.ok('POST', '/api/customer-packs/preview', { pack });
    check(`A: preview of built-in ${id} lists its plans and skills and writes nothing`, preview.canInstall && preview.additions.length === pack.recipes.length &&
      preview.skills.every(s => s.state === 'missing') && read(join(A.data, 'recipes.json')) === before, JSON.stringify({ additions: preview.additions, conflicts: preview.conflicts }));
    const installed = await A.ok('POST', '/api/customer-packs/install', { pack, expectedDigest: preview.digest });
    check(`A: ${id} installs locally ready`, installed.localReady === true && installed.digest === preview.digest);
  }
  const aRecipes = await recipesOf(A);
  check('A: imported plans are unapproved shadows with no clock', aRecipes.length === 5 && aRecipes.every(r => unapproved(r) && r.schedule === null));
  const aLoops = (await loopsOf(A)).filter(l => SHERRY_LOOPS.includes(l.id));
  check("A: Sherry's role-pack loops arrive off", aLoops.length === 3 && aLoops.every(l => l.enabled === false), JSON.stringify(aLoops.map(l => [l.id, l.enabled])));
  // One read plan made in RealBud, with its own clock.
  const local = { id: 'wf-office-a-arrears-read', title: 'Read arrears summary', description: 'Read the supplied arrears file and summarise overdue tenancies for review.', steps: ['Read the supplied arrears file', 'List overdue tenancies for review'],
    evidence: 'A summary with the source file named', capabilities: ['read-files', 'analyse'], schedule: { time: '07:45', weekdays: [1, 2, 3, 4, 5] }, allowedOrigins: [] };
  await A.ok('POST', '/api/recipes', { draft: local });
  const beforeRepeat = read(join(A.data, 'recipes.json')), packsBefore = await A.ok('GET', '/api/customer-packs');
  const repeat = await A.ok('GET', '/api/customer-packs/austin-office/export');
  const repeatPreview = await A.ok('POST', '/api/customer-packs/preview', { pack: repeat });
  await A.ok('POST', '/api/customer-packs/install', { pack: repeat, expectedDigest: repeatPreview.digest });
  const packsAfter = await A.ok('GET', '/api/customer-packs');
  check('A: re-importing the same pack over HTTP changes no plan', repeatPreview.additions.length === 0 && repeatPreview.kept.length === 4 && read(join(A.data, 'recipes.json')) === beforeRepeat &&
    JSON.stringify(packsAfter.installations.map(p => [p.id, p.digest, p.installationRevision])) === JSON.stringify(packsBefore.installations.map(p => [p.id, p.digest, p.installationRevision])));

  const exportOffice = await A.ok('GET', '/api/customer-packs/austin-office/client-export');
  const exportProperty = await A.ok('GET', '/api/customer-packs/austin-property/client-export');
  writeFileSync(join(output, 'office-a-austin-office-export.json'), JSON.stringify(exportOffice, null, 2) + '\n');
  writeFileSync(join(output, 'office-a-austin-property-export.json'), JSON.stringify(exportProperty, null, 2) + '\n');
  const exported = JSON.stringify([exportOffice, exportProperty]);
  check('A: exports leave unsigned, with no local plan, folder path or REI business code', !exportOffice.signature && !exportProperty.signature &&
    !exported.includes(local.id) && !exported.includes(temp) && !exported.includes('businessCode'));
  const propertyLoops = JSON.parse(exportProperty.files['office/settings.json']).loops;
  check("A: Sherry's export carries her three loops, every one off", propertyLoops.map(l => l.id).sort().join() === [...SHERRY_LOOPS].sort().join() && propertyLoops.every(l => l.enabled === false));
  if (!Object.keys(JSON.parse(exportOffice.files['rei/recipes.json']).recipes).includes(learned.name))
    gap('A: learned or locally made recipes travel in an export', 'clientExportPack copies the installed pack only: shipped REI recipes, no watch-and-learn recipe and no local plan.');
  await A.stop();

  // ════ Office B: HTTP boundaries ════
  await boot(B);
  check('B: starts with no packs and no plans', (await B.ok('GET', '/api/customer-packs')).installations.length === 0 && (await recipesOf(B)).length === 0);
  const signedOffice = signWithTool(join(output, 'office-a-austin-office-export.json')), signedProperty = signWithTool(join(output, 'office-a-austin-property-export.json'));
  const { signature: _office, ...officeBody } = signedOffice, { signature: _property, ...propertyBody } = signedProperty;
  check('Publisher: sign-pack.mjs signs the exact exports without changing a byte', JSON.stringify(officeBody) === JSON.stringify(exportOffice) && JSON.stringify(propertyBody) === JSON.stringify(exportProperty));
  writeFileSync(join(output, 'office-a-austin-property-export.fictional-signed.json'), JSON.stringify(signedProperty, null, 2) + '\n');
  let reply = await B.http('POST', '/api/customer-packs/preview', { pack: exportProperty });
  check('B: the unsigned export is refused plainly', plain(reply), reply.body.error);
  reply = await B.http('POST', '/api/customer-packs/preview', { pack: signedProperty });
  check('B: a pack signed by a key RealBud never pinned is refused plainly', plain(reply, /isn.t signed by RealBud/), reply.body.error);

  // Website path, desktop side: the office list is admitted only with the pinned key.
  const builtInProperty = await B.ok('GET', '/api/customer-packs/austin-property/export');
  labPacks = [signedProperty, builtInProperty].map(pack => ({ id: pack.id, title: pack.title, revision: pack.revision, sha256: sha(JSON.stringify(pack)), pack }));
  await B.ok('POST', '/api/office-link', { code: CODE, label: 'Fictional round trip PC' });
  const officeView = await B.ok('GET', '/api/customer-packs/office');
  check('B: packs from the office website need the pinned signature, even a built-in copy', officeView.state === 'ready' && officeView.packs.length === 0 &&
    officeView.refused.length === 2 && officeView.refused.every(r => /isn.t signed by RealBud/.test(r.reason)), JSON.stringify(officeView.refused ?? officeView));

  // Tamper cases on the built-in role pack, the only pack B's service admits unsigned.
  const recipesBefore = read(join(B.data, 'recipes.json'));
  const tamper = (label, edit, pattern) => ({ label, pack: edit(clone(builtInProperty)), pattern });
  const huge = 'Fictional padding. '.repeat(30_000);
  const cases = [
    tamper('a changed byte', p => { p.recipes[0].description = p.recipes[0].description.replace(/\.$/, '!'); return p; }, /differs from the copy built into/),
    tamper('an unknown field', p => ({ ...p, telemetry: true }), /Unsupported pack fields/),
    tamper('a credential-shaped string', p => { p.recipes[0].description += ' password: fictionalPassw0rdValue99'; return p; }, /credential/),
    tamper('a machine path', p => { p.recipes[0].steps[0] += ' (see /Users/fictional/notes.txt)'; return p; }, /machine-specific paths/),
    tamper('a Windows machine path', p => { p.recipes[0].steps[0] += ' (see C:\\Fictional\\notes.txt)'; return p; }, /machine-specific paths/),
    tamper('more than 500 KB', p => { p.recipes[0].description = huge; return p; }, /smaller than 500 KB/),
    tamper('a loop with enabled:true', p => { const s = JSON.parse(p.files['office/settings.json']); s.loops[0].enabled = true; p.files['office/settings.json'] = JSON.stringify(s); return p; }, /switched off/),
  ];
  for (const item of cases) {
    reply = await B.http('POST', '/api/customer-packs/preview', { pack: item.pack });
    const install = await B.http('POST', '/api/customer-packs/install', { pack: item.pack, expectedDigest: 'a'.repeat(64) });
    check(`B: tamper — ${item.label} is refused plainly on preview and install`, plain(reply, item.pattern) && plain(install, item.pattern), `${reply.status} ${reply.body.error}`);
  }
  check('B: refused packs changed nothing', (await B.ok('GET', '/api/customer-packs')).installations.length === 0 && read(join(B.data, 'recipes.json')) === recipesBefore);
  reply = await B.http('POST', '/api/customer-packs/austin-property/uninstall', {});
  if (reply.status === 404) gap('B: uninstall removes only what the pack added', 'No uninstall exists for customer packs (service, route or UI); only upgrade, rollback and retire-by-upgrade.');
  await B.stop();

  // ════ Office B: signed import through the same pack service, B's service stopped ════
  const packs = createCustomerPackService({ directory: B.data, profileDirectory: () => B.profile, workroomDirectory: () => B.vault, trustedKeys: FICTIONAL_KEYS, activeRecipeIds: () => [] });
  const refused = async (work, pattern) => { try { await work(); return false; } catch (error) { return error.status === 400 && pattern.test(error.message); } };
  check('B: the signature verifies against the fictional publisher key', verifyPackSignature(signedOffice, FICTIONAL_KEYS) === KEY_ID && verifyPackSignature(signedProperty, FICTIONAL_KEYS) === KEY_ID);
  const flipped = clone(signedOffice); flipped.recipes[0].title += '.';
  check('B: tamper — a changed byte after signing is refused', await refused(() => packs.preview(flipped), new RegExp(CHANGED_PACK_MESSAGE)));
  const planned = await packs.preview(signedOffice);
  check('B: preview shows every plan and skill the import adds, and writes nothing', planned.canInstall && planned.additions.length === 4 && planned.kept.length === 0 &&
    planned.skills.length === 3 && planned.skills.every(s => s.state === 'missing') && !existsSync(join(B.data, 'customer-packs.json')) && read(join(B.data, 'recipes.json')) === recipesBefore);
  check('B: preview digest is the sha256 of the admitted pack', planned.digest === sha(JSON.stringify(validateCustomerPack(signedOffice))));
  await packs.install(signedOffice, planned.digest);
  await packs.install(signedProperty, (await packs.preview(signedProperty)).digest);
  // A publisher-made pack whose plan carries a clock: it lands on the plan, which waits for approval.
  const CLOCK = { time: '07:15', weekdays: [1, 2, 3, 4, 5] };
  const clockPack = sign({ format: 'realbud-customer-pack', version: 1, id: 'fictional-roundtrip-clock', revision: 1, title: 'Fictional clocked plan',
    workflows: [{ id: 'fictional-clock', title: 'Fictional clocked read', recipeIds: ['wf-fictional-clocked-read'], checks: ['worker'] }],
    recipes: [{ ...local, id: 'wf-fictional-clocked-read', title: 'Fictional clocked read', schedule: CLOCK }],
    skills: [], dependencies: { runtime: 'hermes-property', mode: 'supplied-source-preparation', schedules: 'off', permissions: 'local-review-required' } });
  await packs.install(clockPack, (await packs.preview(clockPack)).digest);
  const bPlans = loadRecipes(true);
  check('B: the exact export installs as unapproved shadow plans', exportOffice.recipes.concat(exportProperty.recipes).every(r => { const p = bPlans.find(x => x.id === r.id); return p && unapproved(p) && p.schedule === null; }));
  const clocked = bPlans.find(r => r.id === 'wf-fictional-clocked-read');
  check("B: a plan's published clock arrives on an unapproved shadow plan", clocked && unapproved(clocked) && JSON.stringify(clocked.schedule) === JSON.stringify(CLOCK));
  const recipesInstalled = read(join(B.data, 'recipes.json'));
  const skillFile = join(B.profile, 'skills/realbud-austin-office-email-inbox-triage/SKILL.md'), skillInstalled = read(skillFile);
  const again = await packs.preview(signedOffice);
  await packs.install(signedOffice, again.digest);
  check('B: re-import is a no-op', again.additions.length === 0 && again.kept.length === 4 && again.skills.every(s => s.state === 'identical') &&
    read(join(B.data, 'recipes.json')) === recipesInstalled && skillInstalled !== null && read(skillFile) === skillInstalled);

  // Upgrade Sherry's pack to a new revision: one plan reworded, one plan added (with a clock the change clears).
  const next = clone(exportProperty); next.revision = 2;
  const kept = next.recipes[0]; kept.title = `${kept.title} (revised)`;
  next.recipes.push({ ...clone(kept), id: 'wf-austin-property-roundtrip-read', title: 'Fictional supplier list read', schedule: CLOCK });
  next.workflows[0].recipeIds.push('wf-austin-property-roundtrip-read');
  const signedNext = sign(next);
  const installedProperty = (await packs.list()).installations.find(p => p.id === 'austin-property');
  const change = await packs.previewUpgrade(signedNext);
  check('B: upgrade preview names the reworded and the added plan', change.canApply && change.recipes.map(r => `${r.id}:${r.action}`).sort().join() ===
    [`${kept.id}:update`, 'wf-austin-property-roundtrip-read:add'].sort().join(), JSON.stringify(change.conflicts));
  await packs.upgrade({ pack: signedNext, expectedInstalledDigest: installedProperty.digest, expectedInstalledRevision: 1, expectedDigest: change.digest, expectedPreviewDigest: change.previewDigest });
  const upgradedPlans = loadRecipes(true);
  check('B: upgrade lands the new revision as unapproved shadows with every clock cleared', upgradedPlans.find(r => r.id === kept.id)?.title === kept.title &&
    ['wf-austin-property-roundtrip-read', kept.id].every(id => { const p = upgradedPlans.find(r => r.id === id); return p && unapproved(p) && p.schedule === null; }));

  // ════ Office B over HTTP after a restart ════
  await boot(B);
  const installs = (await B.ok('GET', '/api/customer-packs')).installations;
  check('B: after restart every pack reads as installed and ready', installs.length === 3 && installs.every(p => p.localReady) &&
    installs.find(p => p.id === 'austin-property')?.revision === 2, JSON.stringify(installs.map(p => [p.id, p.state, p.revision])));
  const clockLoop = (await loopsOf(B)).find(l => l.id === 'recipe-wf-fictional-clocked-read');
  check('B: the carried clock is off and waits for plan approval', clockLoop?.enabled === false && clockLoop.waitingForPlan === true, JSON.stringify(clockLoop));
  const bLoops = (await loopsOf(B)).filter(l => SHERRY_LOOPS.includes(l.id));
  check("B: Sherry's loops are off", bLoops.length === 3 && bLoops.every(l => l.enabled === false), JSON.stringify(bLoops.map(l => [l.id, l.enabled])));
  const target = (await recipesOf(B)).find(r => r.id === kept.id);
  reply = await B.http('POST', `/api/recipes/${kept.id}/prepare`, { requestId: randomUUID(), expectedRevision: target.revision });
  check('B: an imported plan cannot run before it is approved', reply.status === 409, `${reply.status} ${reply.body.error}`);
  // The office then approves the added plan and gives it a clock of its own.
  let added = (await recipesOf(B)).find(r => r.id === 'wf-austin-property-roundtrip-read');
  await B.ok('POST', '/api/recipes', { draft: { ...added, schedule: CLOCK, expectedRevision: added.revision } });
  added = (await recipesOf(B)).find(r => r.id === added.id);
  await B.ok('PATCH', `/api/recipes/${added.id}`, { planApproved: true, status: 'active', expectedRevision: added.revision });
  check('B: an approved plan with a clock runs on the schedule before rollback', (await loopsOf(B)).find(l => l.id === `recipe-${added.id}`)?.enabled === true);

  const property = (await B.ok('GET', '/api/customer-packs')).installations.find(p => p.id === 'austin-property');
  const back = await B.ok('POST', '/api/customer-packs/austin-property/rollback-preview', { installationRevision: 1 });
  await B.ok('POST', '/api/customer-packs/rollback', { packId: 'austin-property', installationRevision: 1, expectedInstalledDigest: property.digest,
    expectedInstalledRevision: property.installationRevision, expectedDigest: back.digest, expectedPreviewDigest: back.previewDigest });
  const rolled = (await B.ok('GET', '/api/customer-packs')).installations.find(p => p.id === 'austin-property');
  const after = await recipesOf(B), restored = after.find(r => r.id === kept.id), retired = after.find(r => r.id === added.id);
  check('B: rollback restores revision 1 and its wording', rolled.revision === 1 && rolled.localReady && restored.title === exportProperty.recipes[0].title && rolled.retiredRecipes.includes(added.id));
  check('B: rollback clears approvals and schedules', unapproved(restored) && retired && unapproved(retired) && retired.schedule === null &&
    !(await loopsOf(B)).some(l => l.id === `recipe-${added.id}` && l.enabled));
  // The in-process install above had no schedule wiring; the HTTP version change sets the pack's loops through the service's one door.
  const austin = await B.ok('GET', '/api/austin-pack'), sherry = (await loopsOf(B)).filter(l => SHERRY_LOOPS.includes(l.id));
  check("B: a version change over HTTP sets the pack's loops, still off, so Schedule lists them", SHERRY_LOOPS.every(id => austin.installed?.loopIds?.includes(id)) &&
    sherry.length === 3 && sherry.every(l => l.enabled === false), JSON.stringify(austin.installed));
} catch (error) {
  exitCode = 1;
  console.error(error instanceof Error ? error.stack : error);
  results.push({ step: 'harness', ok: false, detail: error instanceof Error ? error.message : String(error) });
} finally {
  for (const o of [...running]) await o.stop();
  lab.close();
  const failed = results.filter(r => !r.ok).length;
  if (failed) exitCode = 1;
  // Office folders stay behind only as evidence of a failure.
  if (!exitCode) rmSync(temp, { recursive: true, force: true });
  writeFileSync(join(output, 'receipt.json'), JSON.stringify({ finishedAt: new Date().toISOString(), node: process.version, ...(exitCode ? { fixtureRoot: temp } : {}),
    tier: 'source: two local services on loopback, fictional data and a fictional publisher key',
    limits: ['realbud.app upload, storage and listing (website repo) not run', 'no pack signed with the pinned RealBud key (private key held offline); signed install and upgrade run in-process on B\'s folder',
      'packaged or installed app not run', 'no live REI, Gmail or model'],
    passed: results.length - failed, failed, results, gaps }, null, 2) + '\n');
  console.log(`${results.length - failed} passed, ${failed} failed, ${gaps.length} gaps. Receipt: ${join(output, 'receipt.json')}`);
  process.exit(exitCode);
}
