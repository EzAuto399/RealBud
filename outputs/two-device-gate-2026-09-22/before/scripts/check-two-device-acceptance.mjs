// Read-only receipt completeness gate. This does not operate either desktop or
// establish that a human's recorded observation is correct.
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const text = value => typeof value === 'string' && value.trim().length > 0;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));

export function loadContract() {
  const register = readJson(path.join(root, 'docs/REALBUD-CORE-EXECUTION-2026-09-14.json'));
  const catalogue = readJson(path.join(root, 'docs/REALBUD-OPERATIONAL-ACCEPTANCE-2026-09-15.json'));
  const gate = register.two_device_release_gate;
  if (!gate || catalogue.cases.length !== catalogue.caseCount) throw new Error('Acceptance contract is missing or inconsistent.');
  return { ...gate, caseIds: catalogue.cases.map(item => item.id) };
}

function requiredChecks(contract, pairing) {
  return contract.caseIds.filter(id => pairing.includes('windows') || !contract.windows_only_cases.includes(id));
}

export function createTemplate(contract, target) {
  const pairs = contract.targets[target];
  if (!pairs) throw new Error(`Unknown acceptance target: ${target}`);
  return {
    schemaVersion: 1, target, sourceManifestSha256: null, protocolVersion: null,
    reviewerAlias: null, reviewedAt: null,
    note: 'Fill from actual installed-device runs. Preserve failures; a template is not passing evidence. Evidence paths are relative to this receipt directory.',
    pairings: pairs.map(id => ({
      id, companyAlias: null,
      devices: ['A', 'B'].map((slot, index) => ({
        slot, memberAlias: null, deviceAlias: null, providerUserAlias: null,
        os: id.split('-')[index], osVersion: null, architecture: id.split('-')[index] === 'windows' ? 'x64' : 'arm64',
        environment: null, artifactSha256: null, hermesVersion: null, hermesCommit: null, cuaVersion: null,
      })),
      workflowRuns: contract.workflow_runs.map(run => ({ ...run, status: 'not-run', proofLayer: null, jobId: null, attemptId: null,
        companyAlias: null, workerContextAlias: null, executionDeviceAlias: null, providerUserAlias: null, connectedAccountAlias: null,
        resultReceiptId: null, executionRoute: null, evidence: [] })),
      checks: requiredChecks(contract, id).map(caseId => ({ caseId, status: 'not-run', proofLayer: null,
        participants: contract.both_members_cases.includes(caseId) ? ['A', 'B'] : [], evidence: [] })),
    })),
  };
}

export function checkEvidence(record, contract, { target = 'full-platform', evidenceRoot = '.' } = {}) {
  const issues = [];
  const require = (condition, message) => { if (!condition) issues.push(message); };
  const requiredPairs = contract.targets[target];
  if (!requiredPairs) throw new Error(`Unknown acceptance target: ${target}`);
  const unique = (items, key) => new Set(items.map(item => item?.[key])).size === items.length;
  const list = value => Array.isArray(value) ? value : [];
  const base = realpathSync(evidenceRoot);
  function verifyFiles(files, label) {
    require(Array.isArray(files) && files.length > 0, `${label}: missing evidence files`);
    for (const file of list(files)) {
      try {
        if (!text(file?.path) || path.isAbsolute(file.path) || !hash(file.sha256)) throw new Error('invalid relative path or digest');
        const resolved = realpathSync(path.resolve(base, file.path));
        const relative = path.relative(base, resolved);
        if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('evidence escapes receipt directory');
        const info = statSync(resolved);
        if (!info.isFile() || info.size === 0 || info.size > 16 * 1024 * 1024) throw new Error('expected a nonempty evidence file up to 16 MiB');
        if (sha256(readFileSync(resolved)) !== file.sha256) throw new Error('evidence digest changed');
      } catch (error) { issues.push(`${label}: ${error.message}`); }
    }
  }
  function passed(item, label) {
    require(item?.status === 'pass', `${label}: required passing observation missing`);
    require(item?.proofLayer === 'installed-device', `${label}: installed-device evidence required`);
    verifyFiles(item?.evidence, label);
  }
  require(record?.schemaVersion === 1, 'Unsupported or absent receipt schema');
  require(record?.target === target, 'Receipt target does not match the explicitly requested gate');
  require(hash(record?.sourceManifestSha256), 'Exact candidate source manifest SHA-256 is required');
  require(text(record?.protocolVersion), 'Company protocol version is required');
  require(text(record?.reviewerAlias) && text(record?.reviewedAt) && Number.isFinite(Date.parse(record.reviewedAt)), 'Named review and review date are required');
  const pairs = list(record?.pairings);
  require(unique(pairs, 'id'), 'Duplicate pairing records');
  require(pairs.length === requiredPairs.length && pairs.every(p => requiredPairs.includes(p?.id)), 'Exactly the required pairings must be recorded');
  for (const id of requiredPairs) {
    const pair = pairs.find(p => p?.id === id);
    if (!pair) { issues.push(`${id}: missing installed pairing`); continue; }
    require(text(pair.companyAlias), `${id}: shared company identity required`);
    const devices = list(pair.devices);
    require(devices.length === 2 && unique(devices, 'slot') && devices.every(d => ['A', 'B'].includes(d?.slot)), `${id}: two distinct device slots required`);
    for (const [index, slot] of ['A', 'B'].entries()) {
      const d = devices.find(item => item?.slot === slot);
      for (const key of ['memberAlias', 'deviceAlias', 'providerUserAlias', 'osVersion', 'hermesVersion', 'hermesCommit', 'cuaVersion']) require(text(d?.[key]), `${id}/${slot}: missing ${key}`);
      require(d?.os === id.split('-')[index], `${id}/${slot}: wrong operating system`);
      if (d?.os === 'windows') require(/^Windows 11(?:\s|$)/i.test(d?.osVersion ?? ''), `${id}/${slot}: Windows 11 desktop acceptance required`);
      require(d?.architecture === (d?.os === 'windows' ? 'x64' : 'arm64'), `${id}/${slot}: target architecture not demonstrated`);
      require(hash(d?.artifactSha256), `${id}/${slot}: installed artifact digest required`);
      require(typeof d?.hermesCommit === 'string' && /^[a-f0-9]{40}$/.test(d.hermesCommit), `${id}/${slot}: exact Hermes commit required`);
      require(id === 'macos-macos' ? d?.environment === 'physical' : ['physical', 'interactive-vm'].includes(d?.environment), `${id}/${slot}: native interactive environment required; CI/simulation cannot substitute`);
    }
    for (const key of ['memberAlias', 'deviceAlias', 'providerUserAlias']) require(unique(devices, key), `${id}: members, devices and provider identities must be separate (${key})`);
    const runs = list(pair.workflowRuns);
    require(runs.length === contract.workflow_runs.length && unique(runs, 'id'), `${id}: six distinct workflow runs required`);
    for (const run of contract.workflow_runs) {
      const result = runs.find(item => item?.id === run.id);
      const label = `${id}/${run.id}`;
      passed(result, label);
      require(result?.caseId === run.caseId && result?.member === run.member, `${label}: wrong workflow/member mapping`);
      for (const key of ['jobId', 'attemptId', 'workerContextAlias', 'resultReceiptId']) require(text(result?.[key]), `${label}: missing ${key}`);
      const device = devices.find(item => item?.slot === run.member);
      require(text(result?.companyAlias) && result.companyAlias === pair.companyAlias, `${label}: both workflows must use the intended shared company`);
      require(text(result?.executionDeviceAlias) && result.executionDeviceAlias === device?.deviceAlias, `${label}: execution must be on that member's device`);
      require(result?.executionRoute === 'company-managed-hermes', `${label}: local/fake/unmanaged worker is not shared execution proof`);
      if (run.id.startsWith('morning-')) {
        require(text(result?.providerUserAlias) && result.providerUserAlias === device?.providerUserAlias && text(result?.connectedAccountAlias), `${label}: exact personal source account required`);
      }
    }
    require(unique(runs, 'jobId'), `${id}: reusing one job cannot prove separate workflow runs`);
    const aContexts = new Set(runs.filter(r => r?.member === 'A').map(r => r.workerContextAlias));
    require(!runs.some(r => r?.member === 'B' && aContexts.has(r.workerContextAlias)), `${id}: private worker contexts overlap`);
    const mornings = runs.filter(r => r?.id?.startsWith('morning-'));
    require(unique(mornings, 'connectedAccountAlias'), `${id}: both users need their own source account`);
    const checks = list(pair.checks);
    const caseIds = requiredChecks(contract, id);
    require(checks.length === caseIds.length && checks.every(c => caseIds.includes(c?.caseId)), `${id}: exactly the applicable operational cases must be recorded`);
    require(unique(checks, 'caseId'), `${id}: duplicate operational case records`);
    for (const caseId of caseIds) {
      const check = checks.find(item => item?.caseId === caseId);
      passed(check, `${id}/${caseId}`);
      if (contract.both_members_cases.includes(caseId)) require(['A', 'B'].every(slot => list(check?.participants).includes(slot)), `${id}/${caseId}: both members/devices must be observed`);
    }
  }
  return { target, evidenceComplete: issues.length === 0, issues,
    verification: 'Recorded coverage and local evidence-file integrity only. Independent review must verify native behavior and candidate attribution. This does not grant release, deployment or customer acceptance.' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), contract = loadContract();
    if (args[0] === '--template' && args.length === 2) console.log(JSON.stringify(createTemplate(contract, args[1]), null, 2));
    else {
      if (args.length < 1 || args.length > 2) throw new Error('Usage: pnpm qa:two-device-evidence <receipt.json> [macos-rehearsal|full-platform], or --template <target>. The default is full-platform.');
      const file = path.resolve(args[0]);
      const result = checkEvidence(readJson(file), contract, { target: args[1] ?? 'full-platform', evidenceRoot: path.dirname(file) });
      console.log(JSON.stringify(result, null, 2));
      if (!result.evidenceComplete) process.exitCode = 1;
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
