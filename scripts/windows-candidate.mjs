/** Source gates for Windows artifacts. This never publishes or changes a feed.
 * Native installed CI is a limited proof layer. Current Windows worker OS
 * containment is held, so stable/public promotion has no admission path. */
import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const STABLE_WINDOWS_HOLD = 'Stable Windows promotion is held: the exact candidate still needs admitted native worker isolation, upgrade/restore and required customer-device evidence. Installed CI or caller-provided approval flags cannot remove this hold.';
const requireProof = (condition, message) => { if (!condition) throw new Error(message); };
const sha = value => createHash('sha256').update(value).digest('hex');
const commit = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function fileDigest(path) {
  const stat = lstatSync(path); requireProof(stat.isFile() && !stat.isSymbolicLink(), 'Candidate proof must be a plain file.');
  const fd = openSync(path, 'r'), hash = createHash('sha256'), chunk = Buffer.alloc(1024 * 1024);
  try { for (let n; (n = readSync(fd, chunk, 0, chunk.length, null));) hash.update(chunk.subarray(0, n)); }
  finally { closeSync(fd); }
  return hash.digest('hex');
}
function json(path) {
  requireProof(lstatSync(path).size <= 2 * 1024 * 1024, 'Candidate receipt exceeds its bound.');
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
}
export function windowsBuildAdmission(input) {
  const { intent, proof, workflowRef, workflowSha, sourceRevision, requestedRef = '', signProfile = '', publisher = '' } = input;
  requireProof(['rehearsal', 'signed-ci-candidate', 'stable-public'].includes(intent), 'Choose explicit Windows qualification intent.');
  if (intent === 'stable-public') throw new Error(STABLE_WINDOWS_HOLD);
  requireProof(commit(sourceRevision) && commit(workflowSha), 'Full source and workflow commit identities are required.');
  requireProof(['all', 'installer', 'managed-runtime'].includes(proof), 'Unknown Windows proof selection.');
  const mainBound = workflowRef === 'refs/heads/main' && sourceRevision === workflowSha && ['', 'main', 'refs/heads/main', workflowSha].includes(requestedRef);
  const signing = Boolean(signProfile.trim() && publisher.trim() && mainBound);
  if (intent === 'signed-ci-candidate') {
    requireProof(proof === 'all', 'A signed CI candidate requires both exact native jobs.');
    requireProof(mainBound, 'Signing requires the exact main workflow source; a tag or moved ref is a rehearsal.');
    requireProof(signing, 'Approved Windows signing profile and publisher are required; unsigned fallback is refused.');
  }
  return { schema: 1, intent, sourceRevision, signing, stablePromotionReady: false,
    artifactKind: intent === 'rehearsal' ? 'windows-rehearsal' : 'windows-signed-ci-candidate',
    limits: [STABLE_WINDOWS_HOLD, 'Rehearsal and candidate artifacts never update a stable feed or tag.'] };
}

const CHILD_RECEIPTS = ['installed-windows.json', 'installed-memory-primitives.json', 'installed-service.json', 'installed-private-backup.json', 'installed-gui.json'];
export function validateInstalledReceipt(lifecycle, { sourceRevision, installer, receiptDirectory }) {
  requireProof(lifecycle?.schema === 1 && lifecycle.kind === 'realbud-installed-windows-lifecycle' && lifecycle.proofLayer === 'installed-runtime-on-disposable-windows-ci', 'Native installed lifecycle schema is required.');
  requireProof(lifecycle.sourceRevision === sourceRevision, 'Installed lifecycle belongs to another source candidate.');
  requireProof(lifecycle.installer?.file === basename(installer) && lifecycle.installer.bytes === lstatSync(installer).size && lifecycle.installer.sha256 === fileDigest(installer), 'Installed lifecycle does not identify these exact installer bytes.');
  requireProof(lifecycle.passed === true && lifecycle.failureStage === null && lifecycle.installation?.started === true && lifecycle.installation.exitCode === 0 && lifecycle.installation.appCreated === true, 'Fresh native installation did not pass.');
  requireProof(lifecycle.probes?.passed === true && lifecycle.probes.gui?.passed === true && lifecycle.probes.gui.started === true && lifecycle.probes.gui.rendererReady === true && lifecycle.probes.gui.windowObserved === true && lifecycle.probes.gui.exitCode === 0, 'Exact installed GUI and runtime probes are required.');
  requireProof(lifecycle.uninstall?.passed === true && lifecycle.uninstall.exitCode === 0 && lifecycle.uninstall.appRemoved === true && lifecycle.uninstall.resourcesRemoved === true, 'Disposable native uninstall did not pass.');
  const links = lifecycle.probes.receipts;
  requireProof(Array.isArray(links) && links.length <= 6 && new Set(links.map(row => row?.file)).size === links.length, 'Lifecycle child receipts are incomplete or duplicated.');
  for (const row of links) requireProof([...CHILD_RECEIPTS, 'installed-gui-observation.json'].includes(row?.file) && digest(row.sha256), 'Unexpected lifecycle receipt reference.');
  for (const file of CHILD_RECEIPTS) {
    const link = links.find(row => row.file === file), path = join(receiptDirectory, file);
    requireProof(link && fileDigest(path) === link.sha256, 'A required exact child receipt is missing or changed.');
    const child = json(path);
    if (file === 'installed-gui.json') requireProof(child.ok === true && child.result?.title === 'RealBud' && child.result.capabilities?.host?.platform === 'win32' && child.result.health?.app === 'realbud' && child.result.health.static === true && child.result.company?.remoteJoinAvailable === true, 'Installed GUI receipt must confirm the real renderer, service and join surface.');
    else requireProof(child.passed === true && child.platform === 'win32', 'A child probe is not a passing native Windows receipt.');
    if (file === 'installed-windows.json') requireProof(child.sourceRevision === sourceRevision && typeof child.electron === 'string' && Array.isArray(child.checks) && child.checks.length > 0, 'Installed helper receipt is not candidate-bound Electron evidence.');
    if (file === 'installed-private-backup.json') requireProof(child.mode === 'packaged' && child.runtime?.electron && Array.isArray(child.checks) && child.checks.length > 0, 'Private restore proof must use the installed packaged runtime.');
  }
  return { installerSha256: lifecycle.installer.sha256, lifecycleSha256: fileDigest(join(receiptDirectory, 'installed-lifecycle.json')) };
}

/** This performs native trust evaluation; no signature boolean is accepted
 * from a caller or JSON receipt. The subprocess prints public certificate facts. */
export function inspectAuthenticode(path) {
  requireProof(process.platform === 'win32', 'Authenticode qualification requires native Windows.');
  const literal = `'${resolve(path).replaceAll("'", "''")}'`;
  const script = `$ErrorActionPreference='Stop'; $s=Get-AuthenticodeSignature -LiteralPath ${literal}; [ordered]@{status=[string]$s.Status;publisher=$(if($s.SignerCertificate){$s.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false)}else{$null});timestamp=$(if($s.TimeStamperCertificate){$s.TimeStamperCertificate.Thumbprint}else{$null})}|ConvertTo-Json -Compress`;
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 30_000, windowsHide: true }).replace(/^\uFEFF/, ''));
}
export function qualifyInstalledCandidate(input, inspect = inspectAuthenticode) {
  requireProof(input.intent === 'signed-ci-candidate', 'Only explicit signed CI intent can qualify installed candidate evidence.');
  requireProof(commit(input.sourceRevision) && typeof input.publisher === 'string' && input.publisher.trim(), 'Exact source identity and approved publisher are required.');
  const before = [fileDigest(input.installer), fileDigest(input.application)];
  const signatures = [input.installer, input.application].map(path => {
    const signature = inspect(path);
    requireProof(signature.status === 'Valid' && signature.publisher === input.publisher && typeof signature.timestamp === 'string' && signature.timestamp.length > 0, 'Installer and application require valid expected-publisher timestamped Authenticode signatures.');
    return signature;
  });
  const identity = validateInstalledReceipt(json(join(input.receiptDirectory, 'installed-lifecycle.json')), input);
  requireProof(before[0] === fileDigest(input.installer) && before[1] === fileDigest(input.application), 'Candidate bytes changed during qualification.');
  return { schema: 1, kind: 'realbud-signed-installed-windows-ci-candidate', sourceRevision: input.sourceRevision,
    proofLayer: 'signed-fresh-install-on-disposable-windows-ci', ...identity, applicationSha256: before[1], publisher: input.publisher, signatures,
    stablePromotionReady: false, limits: [STABLE_WINDOWS_HOLD, 'Fresh disposable CI installation only; no upgrade, physical office, live account or customer acceptance proof.'] };
}

export function validateManagedJournal(runtime, journal, sourceRevision, root) {
  requireProof(runtime?.schema === 1 && runtime.kind === 'realbud-managed-windows-runtime-proof' && runtime.passed === true && runtime.platform === 'win32' && runtime.sourceRevision === sourceRevision, 'Exact native managed setup receipt is required.');
  requireProof(journal?.schema === 1 && journal.kind === 'realbud-native-windows-memory-journal-proof' && journal.passed === true && journal.platform === 'win32' && journal.reported_source_revision === sourceRevision && journal.runtime_commit === runtime.runtimeCommit && journal.selected_runtime === runtime.runtimeDirectory, 'Managed runtime and journal belong to different candidates.');
  requireProof(journal.native_windows_validation === true && journal.cleanup === true && journal.sources_unchanged === true && journal.status === 'passed', 'Native journal execution, unchanged inputs and cleanup are required.');
  const harness = join(root, 'scripts/testing/hermes-memory-windows-journal-native.py'), text = readFileSync(harness, 'utf8');
  const expected = ['CORE_CASES', 'EXTRA_CASES'].flatMap(name => {
    const table = text.match(new RegExp(`^${name} = \\(([\\s\\S]*?)\\)`, 'm'));
    requireProof(table, 'Reviewed native journal case table is missing.');
    return [...table[1].matchAll(/"(test_[a-z_]+)"/g)].map(match => match[1]);
  });
  requireProof(Array.isArray(journal.checks) && journal.checks.length === expected.length && journal.expected_checks === expected.length && new Set(journal.checks.map(row => row.name)).size === expected.length && journal.checks.every(row => expected.includes(row.name) && row.status === 'passed'), 'Every reviewed native journal scenario must pass; skips or partial receipts do not qualify.');
  requireProof(journal.input_hashes?.harness === fileDigest(harness) && journal.input_hashes.scenario_assertions === fileDigest(join(root, 'scripts/testing/hermes-memory-windows-journal.py')) && journal.input_hashes.admission === fileDigest(join(root, 'server/hermes-memory-review.ts')), 'Native journal is not bound to current harness and admission source.');
  const helpers = [...text.match(/^HELPERS = \(([\s\S]*?)\)/m)[1].matchAll(/"([^"]+\.py)"/g)].map(match => match[1]);
  for (const helper of helpers) requireProof(journal.input_hashes.helpers?.[helper] === fileDigest(join(root, 'server/helpers', helper)), 'Native journal helper bytes changed.');
  const admission = readFileSync(join(root, 'server/hermes-memory-review.ts'), 'utf8');
  const admittedCommit = admission.match(/MEMORY_REVIEW_RUNTIME\s*=\s*['"]([a-f0-9]{40})['"]/)[1];
  const table = admission.match(/MEMORY_REVIEW_NATIVE_FILES\s*=\s*\{([\s\S]*?)\}/)[1];
  const admittedFiles = Object.fromEntries([...table.matchAll(/['"]([^'"]+)['"]\s*:\s*['"]([a-f0-9]{64})['"]/g)].map(match => [match[1], match[2]]));
  requireProof(runtime.runtimeCommit === admittedCommit && Object.keys(admittedFiles).length > 0 && Object.keys(journal.input_hashes.runtime_files ?? {}).length === Object.keys(admittedFiles).length && Object.entries(admittedFiles).every(([file, hash]) => journal.input_hashes.runtime_files?.[file] === hash) && digest(journal.input_hashes.runtime_python), 'Native runtime files do not match the reviewed admission table.');
  return { managedRuntimeCommit: runtime.runtimeCommit, journalHarnessSha256: sha(Buffer.from(text)), journalChecks: expected.length, stablePromotionReady: false };
}

function sourceIdentity(root) {
  const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  requireProof(!execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root, encoding: 'utf8' }).trim(), 'Candidate source must be clean; receipts cannot qualify uncommitted source.');
  return sourceRevision;
}
function main() {
  const [command, ...args] = process.argv.slice(2), root = resolve(import.meta.dirname, '..');
  if (command === 'stable-public') throw new Error(STABLE_WINDOWS_HOLD);
  const sourceRevision = sourceIdentity(root), intent = process.env.WINDOWS_QUALIFICATION || 'rehearsal';
  if (command === 'preflight') {
    const result = windowsBuildAdmission({ intent, sourceRevision, workflowRef: process.env.GITHUB_REF, workflowSha: process.env.GITHUB_SHA, requestedRef: process.env.WINDOWS_REQUESTED_REF || '', proof: process.env.WINDOWS_PROOF || 'all', signProfile: process.env.AZURE_SIGN_PROFILE || '', publisher: process.env.AZURE_SIGN_PUBLISHER || '' });
    if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `signing=${result.signing}\nartifactKind=${result.artifactKind}\nsourceRevision=${result.sourceRevision}\n`, { flag: 'a' });
    process.stdout.write(`${JSON.stringify(result)}\n`); return;
  }
  if (command === 'installed' && args.length === 4) {
    const [installer, application, receiptDirectory, output] = args;
    const result = qualifyInstalledCandidate({ intent, sourceRevision, publisher: process.env.AZURE_SIGN_PUBLISHER, installer, application, receiptDirectory });
    writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' }); return;
  }
  if (command === 'joined' && args.length === 4) {
    const [installed, runtimePath, journalPath, output] = args, qualification = json(installed);
    requireProof(qualification.kind === 'realbud-signed-installed-windows-ci-candidate' && qualification.sourceRevision === sourceRevision && qualification.stablePromotionReady === false && digest(qualification.installerSha256) && digest(qualification.applicationSha256), 'Signed installed CI candidate receipt is required.');
    const result = validateManagedJournal(json(runtimePath), json(journalPath), sourceRevision, root);
    writeFileSync(output, `${JSON.stringify({ schema: 1, kind: 'realbud-windows-ci-receipt-bundle', sourceRevision, ...result, receiptHashes: { installed: fileDigest(installed), runtime: fileDigest(runtimePath), journal: fileDigest(journalPath) }, limits: qualification.limits }, null, 2)}\n`, { flag: 'wx' }); return;
  }
  throw new Error('Use preflight, installed <installer> <application> <receipts> <output>, joined <installed> <runtime> <journal> <output>, or stable-public.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
