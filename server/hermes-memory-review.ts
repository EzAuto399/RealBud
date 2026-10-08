/** RealBud owns review authority and, through server/hermes-memory-owned.ts, the
 * memory itself: reviews read and commit RealBud's canonical worker state and
 * need no worker Python. The native helper below is kept, unselected, for the
 * opt-in native proofs; it is never mixed with owned state at runtime. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentWorkerProfile, withWorkerProfile } from './hermes-profile.ts';
import { hermesHome, runtimeCli } from './hermes-paths.ts';
import { propertyProfileDir } from './hermes-pack.ts';
import { readRuntimeSelection, releaseHome, runtimeCommit, selectedHermesCli } from './hermes-runtime-selection.ts';
import { spawnCli, killCliTree } from './procs.ts';
import { DATA_DIR } from './config.ts';
import { ensurePrivateRoot, sandboxedLaunch, trackSandboxedChild } from './worker-network-sandbox.ts';
import { containsCredential } from './redact.ts';
import { MEMORY_REVIEW_API, MEMORY_REVIEW_ERRORS, MEMORY_LEARNING_API, MEMORY_LEARNING_KEPT_LIMIT, memoryReviewId, memoryReviewDigest,
  parseMemoryReviewPage, parseMemoryReviewPreview, parseMemoryReviewDecision,
  type MemoryReviewErrorCode, type MemoryReviewItem, type MemoryReviewPage, type MemoryReviewPreview, type MemoryReviewDecision,
  type MemoryLearningState, type MemoryLearningUndo } from '../shared/hermes-memory-review.ts';
import { addedLearningText, classifyLearning, exactLearningRemoval, learningHold, type LearningHold } from '../shared/learning-policy.ts';
import { createLearningStore, defaultLearningDirectory, learningTextDigest, markUndone, publicLearningState,
  type LearningEntry, type LearningUndo } from './learning-auto-keep.ts';
import type { WorkspaceActivity } from './workspace-activity.ts';
import { MEMORY_RECOVERY_API, parseMemoryRecoveryPage, parseMemoryRecoveryClosure } from '../shared/hermes-memory-recovery.ts';
import { parseMemoryProposalInput, parseMemoryProposalResult, type MemoryProposalInput, type MemoryProposalResult } from '../shared/hermes-memory-proposal.ts';
import { OWNED_MEMORY_RUNTIME, runOwnedMemoryReview } from './hermes-memory-owned.ts';
import { memorySigningKey } from './hermes-memory-signing.ts';

/** Hermes 0.21.3 (v2026.9.14): staged replace/remove select by old_text. */
export const MEMORY_REVIEW_RUNTIME = '345cd2b057a452236de401d3534b8502a7465e8d';
export const MEMORY_REVIEW_NATIVE_FILES = {
  'tools/memory_tool.py': 'ed9c5db6b3144b88425f7039280239b29a047143aa8ffdfd3b7f47bf7e707143',
  'tools/memory_tool_store.py': '811ef2eb98a8b3f0448294b2c23d422ff7ebd4dc45835475b12df0557d7e5366',
  'tools/write_approval.py': '9404792bc8c6637e5bd78a87f5a6dfabda6cd6a1a61083b450647ddb2951c470',
  'tools/threat_patterns.py': '6ad8947a5a62db44f66b1cd33086e2b51c4a66019ef5301856e5efae59797341',
  'tools/__init__.py': '7bca460f476ac9ace706c8cfd07e98f8aae34d839862f0f68abafc3a8397cf35',
  'tools/registry.py': '310a57a5dc5d41c935eacbe707e8a258dc21fd72fd44fccbc33d1a78b7143922',
  'utils.py': '1414f177e14940750ad80d6dd5020685219ca26b0b7d500299ab2f170118ed07',
  'hermes_constants.py': 'e5f72a309b3689f5fa2e85065e8051f8e6f7686d1ec1741e7543cc5e56bea162',
} as const;
/** Hermes 0.21.5 (v2026.9.24): staged replace/remove carry the pinned `matched_entry`;
 * `hermes_constants` now imports `hermes_platform.host.runtime` (whose package init loads `facts`). */
export const MEMORY_REVIEW_CANDIDATE_RUNTIME = 'f97608f178d1ffeca59860195ab7da295f7c8e5f';
export const MEMORY_REVIEW_CANDIDATE_NATIVE_FILES = {
  'tools/memory_tool.py': '214870bfcc4c67cc502459d16dda9bd4627e58ae521d73ee03e41afc598f6178',
  'tools/memory_tool_store.py': '2a44cc0ea35066a4320395d63997f26011525c9ffe04183e562e16575837f488',
  'tools/write_approval.py': 'cfcf19593947033464224ceda835bb6aed54550b24b6cdfe7dc2ea356234a898',
  'tools/threat_patterns.py': 'a27cb85ce18e93485959537cf054608df76b9e78c36607be5865069f679c7664',
  'tools/__init__.py': '7bca460f476ac9ace706c8cfd07e98f8aae34d839862f0f68abafc3a8397cf35',
  'tools/registry.py': '1dd185b85dee4e578905273668369efc3abd8ce6d55abf8fa3d133393cb9dedc',
  'utils.py': '15c10bc1a0499368f76f3092c15c2e4960bc2faa7f23b54bd1d8502190d8ed41',
  'hermes_constants.py': '3dd95a77b1a4956280f146e3b065789ca5d82921f69e6e2cae06d49a13f82405',
  'hermes_platform/__init__.py': '698ba6987eb24da01e63c336607529af9cd38f8694c58f7b96e484b22cbdf5a6',
  'hermes_platform/host/__init__.py': 'af071e6da9cf17505724bea27a75798f4ec6cd296a8e9821b0bab11bcc06e55b',
  'hermes_platform/host/facts.py': '964197c6571e8d0be7fd2da1ccd61bbd5b69e1fdf134680f353f955b2b95ef5e',
  'hermes_platform/host/runtime.py': 'fd760a3f044d6201aa5b543d0166de11f27e2da6a700839623ebd67ce1037d6a',
} as const;
/** Admitted runtimes keyed by upstream commit; the helper detects the pinning schema from the bound modules. */
export const MEMORY_REVIEW_RUNTIMES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  [MEMORY_REVIEW_RUNTIME]: MEMORY_REVIEW_NATIVE_FILES,
  [MEMORY_REVIEW_CANDIDATE_RUNTIME]: MEMORY_REVIEW_CANDIDATE_NATIVE_FILES,
};
const admittedNativeFiles = (runtimeId: string | null) => { const commit = runtimeCommit(runtimeId); return commit && Object.hasOwn(MEMORY_REVIEW_RUNTIMES, commit) ? MEMORY_REVIEW_RUNTIMES[commit] : null; };
export interface MemoryReviewContext { profileDirectory: string; runtimeDirectory: string; workspaceId: string; profileId: string; runtimeId: string; python: string }
type Command = { command: 'list'; cursor?: string } | { command: 'preview'; id: string } | { command: 'decide'; id: string; expectedDigest: string; decision: 'approve' | 'reject' }
  | { command: 'interrupted-list'; cursor?: string } | { command: 'interrupted-close'; proposalKey: string; expectedDigest: string }
  | { command: 'propose'; scopeId: string; input: MemoryProposalInput; legacyScopeIds?: string[] };
type Request = Omit<MemoryReviewContext, 'python'> & Command & { version: 1; key: string };
const mutating = (command: Command) => command.command === 'decide' || command.command === 'propose' || command.command === 'interrupted-close';
const helper = fileURLToPath(new URL('./helpers/hermes-memory-review.py', import.meta.url));
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
function fail(code: MemoryReviewErrorCode, status = code === 'unavailable' ? 503 : 409): never { throw Object.assign(new Error(MEMORY_REVIEW_ERRORS[code]), { code, status }); }
const samePath = (a: string, b: string) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
/** Owned reviews bind the workspace and member profile only; no worker runtime is selected or required. */
export function memoryReviewContext(workspaceId: string): MemoryReviewContext {
  return { profileDirectory: propertyProfileDir(), runtimeDirectory: '', workspaceId, profileId: currentWorkerProfile().profile, runtimeId: OWNED_MEMORY_RUNTIME, python: '' };
}
/** The native helper's context: the selected, admitted runtime. */
export function nativeMemoryReviewContext(workspaceId: string): MemoryReviewContext {
  const home = hermesHome(), selection = readRuntimeSelection(home).selected;
  if (!selection || !admittedNativeFiles(selection)) fail('unsupported');
  const runtimeDirectory = join(releaseHome(home, selection), 'hermes-agent');
  // An update affects the next process. Do not review under a different runtime
  // than the current worker, or follow an arbitrary CLI override from a request.
  if (!samePath(selectedHermesCli(home), runtimeCli(releaseHome(home, selection)))) fail('unsupported');
  return { profileDirectory: propertyProfileDir(), runtimeDirectory, workspaceId, profileId: currentWorkerProfile().profile, runtimeId: selection,
    python: join(runtimeDirectory, 'venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python') };
}
async function ancestors(path: string) {
  const absolute = resolve(path), root = parse(absolute).root; let current = root;
  for (const part of absolute.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part); const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('unsafe-storage');
  }
}
async function digestFile(path: string) {
  await ancestors(dirname(path)); const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 2 * 1024 ** 2) fail('unsupported');
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await file.stat(); if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) fail('unsupported');
    const bytes = await file.readFile(), after = await file.stat();
    if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) fail('unsupported');
    return createHash('sha256').update(bytes).digest('hex');
  } finally { await file.close(); }
}
const WORKSPACE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/, PROFILE = /^property(?:-[a-z0-9-]+)?$/;
/** Owned admission: trusted identity shape only. Windows keeps its platform hold
 * until owned review is proven there (pending work is preserved meanwhile). */
export async function validateOwnedMemoryContext(context: MemoryReviewContext) {
  if (process.platform === 'win32') fail('platform-unverified');
  if (!WORKSPACE.test(context.workspaceId) || !PROFILE.test(context.profileId) || context.profileId.length > 64 || context.runtimeId !== OWNED_MEMORY_RUNTIME) fail('unsupported');
}
/** The default invoke: RealBud-owned operations with the helper's request/response contract. */
export function invokeOwnedMemoryReview(context: MemoryReviewContext, request: Request, options: { signal?: AbortSignal; dataDir?: string } = {}): Promise<unknown> {
  return runOwnedMemoryReview({ ...request, profileDirectory: context.profileDirectory }, { signal: options.signal, dataDir: options.dataDir });
}
export async function validateNativeMemoryRuntime(context: MemoryReviewContext) {
  // The native Python helper has not admitted Windows per-file ACL and durable
  // rename behavior yet. A private profile ACL alone cannot vouch for explicit
  // grants on existing child files. Preserve pending data until that gate passes.
  if (process.platform === 'win32') fail('platform-unverified');
  const files = admittedNativeFiles(context.runtimeId);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(context.workspaceId) || !/^property(?:-[a-z0-9-]+)?$/.test(context.profileId) || context.profileId.length > 64 || !files) fail('unsupported');
  await ancestors(context.profileDirectory);
  for (const [name, expected] of Object.entries(files)) if (await digestFile(join(context.runtimeDirectory, name)) !== expected) fail('unsupported');
}
export function memoryReviewChildEnvironment(context: MemoryReviewContext, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP']) if (source[name]) env[name] = source[name];
  env.HERMES_HOME = context.profileDirectory; env.HERMES_SKIP_DOTENV = '1'; env.PYTHONDONTWRITEBYTECODE = '1';
  return env;
}
/** What the helper writes: the memory files, the worker's staged proposals
 * and RealBud's review state; never config.yaml, .env, bin/ or skills. */
export function memoryReviewWritable(context: MemoryReviewContext): string[] {
  return [join(context.profileDirectory, 'memories'), join(context.profileDirectory, 'pending', 'memory'), join(context.profileDirectory, '.realbud-memory-reviews')];
}
/** Resolve only after the owned helper exits; a deadline never means applied. */
export function runMemoryReviewHelper(context: MemoryReviewContext, request: Request, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<unknown> {
  return new Promise((accept, reject) => {
    if (options.signal?.aborted) { reject(Object.assign(new Error(MEMORY_REVIEW_ERRORS.unavailable), { code: 'unavailable', status: 503 })); return; }
    // The host helper runs the runtime's Python under the worker sandbox: no
    // network, writes only inside this profile, the runtime read-only.
    const env = memoryReviewChildEnvironment(context);
    let launch: ReturnType<typeof sandboxedLaunch>;
    try {
      // A fresh profile has not staged a proposal yet. Validate/create its
      // parent on the host; the helper still receives only pending/memory.
      ensurePrivateRoot(join(context.profileDirectory, 'pending'));
      launch = sandboxedLaunch(context.python, ['-I', '-B', helper], env, { loopbackPorts: [], writable: memoryReviewWritable(context), links: memoryReviewWritable(context), reads: [['deny', DATA_DIR], ['allow', context.runtimeDirectory], ['allow', context.profileDirectory]] });
    }
    catch { reject(Object.assign(new Error(MEMORY_REVIEW_ERRORS.unavailable), { code: 'unavailable', status: 503 })); return; }
    const child = trackSandboxedChild(spawnCli(launch.command, launch.args, { cwd: context.runtimeDirectory, env, stdio: ['pipe', 'pipe', 'pipe'], privateFiles: true }));
    let size = 0, killed = false, spawnFailed = false, force: ReturnType<typeof setTimeout> | undefined;
    const chunks: Buffer[] = [];
    const stop = () => { if (killed) return; killed = true; killCliTree(child); force = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 2000); force.unref(); };
    const timer = setTimeout(stop, options.timeoutMs ?? 20_000); timer.unref();
    options.signal?.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 1024 * 1024) { stop(); return; } chunks.push(Buffer.from(chunk)); });
    // Native diagnostics can contain private text. Consume without logging.
    child.stderr.on('data', () => {}); child.on('error', () => { spawnFailed = true; });
    child.stdin.on('error', stop);
    child.once('close', code => {
      clearTimeout(timer); if (force) clearTimeout(force); launch.release();
      options.signal?.removeEventListener('abort', stop);
      const buffer = Buffer.concat(chunks); for (const chunk of chunks) chunk.fill(0);
      try {
        if (killed || spawnFailed || code !== 0) fail(mutating(request) ? 'recovery-required' : 'unavailable', 503);
        accept(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)));
      } catch (error) {
        reject(mutating(request) ? Object.assign(new Error(MEMORY_REVIEW_ERRORS['recovery-required']), { code: 'recovery-required', status: 503 }) : error);
      } finally { buffer.fill(0); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}
/** Background auto-review cadence and per-pass helper budgets. */
export const LEARNING_AUTO_REVIEW_MS = 5 * 60_000;
const LIST_PASS_STEPS = 6, INTERVAL_PASS_STEPS = 40, PASS_PAGES = 10;
const STOP = Symbol('auto-review-stop');
const errorCode = (error: unknown) => (error as { code?: unknown } | null)?.code;
export function createHermesMemoryReviewService(options: {
  context: () => MemoryReviewContext; key: () => Buffer; withActivity?: WorkspaceActivity;
  /** Trusted seams, never serialized or available through HTTP. Defaults are the owned operations. */
  validateRuntime?: typeof validateOwnedMemoryContext; invoke?: typeof runMemoryReviewHelper;
  /** Defaults to RealBud's data directory, outside the worker's writable home. */
  learningDirectory?: (context: MemoryReviewContext) => string; autoReviewIntervalMs?: number; now?: () => number;
  /** RealBud's data directory for owned state and the carried signing keys (tests use a temporary one). */
  dataDirectory?: string;
  /** The helper-era context a 0.1.42 conversation was bound to, for retrying its proposals. */
  legacyContext?: (workspaceId: string) => MemoryReviewContext;
}) {
  const active = new Set<string>(), controllers = new Set<AbortController>(), drains = new Set<Promise<void>>();
  let closed = false;
  const now = options.now ?? Date.now;
  const dataDirectory = options.dataDirectory ?? DATA_DIR;
  const learningDirectory = options.learningDirectory ?? ((context: MemoryReviewContext) => defaultLearningDirectory(context, dataDirectory));
  const learningStore = (context: MemoryReviewContext) => createLearningStore(learningDirectory(context), { workspaceId: context.workspaceId, profileId: context.profileId }, now);
  const exec = <T>(work: () => Promise<T>): Promise<T> => options.withActivity ? options.withActivity(work) : work();
  const ownerFor = (context: MemoryReviewContext) => ({ signal: new AbortController().signal, context: JSON.stringify(context), isCurrent: () => true });
  // Auto-review yields to people: a person's request waits for at most the one
  // helper call in flight, and the pass stops before its next step.
  let waiting = 0, step: Promise<unknown> | null = null, pass: Promise<void> | null = null;
  const holds = new Map<string, { key: string; hold: LearningHold }>(); let holdsIdentity = '';
  const holdKey = (item: MemoryReviewItem) => `${item.id}:${item.createdAt}:${item.action}:${item.target}`;
  async function settle() { while (step || pass) await Promise.allSettled([step, pass]); }
  async function asPerson<T>(work: () => Promise<T>): Promise<T> { waiting++; try { await settle(); return await work(); } finally { waiting--; } }
  async function run(input: Command, owner?: { signal: AbortSignal; context: string; isCurrent(): boolean }) {
    if (closed) fail('unavailable', 503);
    const context = options.context(), identity = JSON.stringify(context);
    const checkOwner = () => {
      if (owner && (owner.signal.aborted || !owner.isCurrent() || identity !== owner.context)) fail('stale-review');
    };
    checkOwner();
    const lockId = process.platform === 'win32' ? resolve(context.profileDirectory).toLowerCase() : resolve(context.profileDirectory);
    if (active.has(lockId)) fail('busy');
    const controller = new AbortController(); controllers.add(controller);
    const abort = () => controller.abort();
    owner?.signal.addEventListener('abort', abort, { once: true });
    let finish!: () => void;
    const drained = new Promise<void>(done => { finish = done; }); drains.add(drained);
    active.add(lockId);
    let dispatched = false, classifiedRefusal = false;
    try {
      await (options.validateRuntime ?? validateOwnedMemoryContext)(context);
      if (controller.signal.aborted) fail('unavailable', 503);
      checkOwner();
      if (JSON.stringify(options.context()) !== identity) fail('stale-review');
      const sourceKey = options.key(); if (!Buffer.isBuffer(sourceKey) || sourceKey.length !== 32) fail('unavailable');
      // Carried by private backups, so restored decisions and journals keep verifying.
      const signingKey = await memorySigningKey(sourceKey, context.workspaceId, context.profileId, dataDirectory).catch(() => fail('unavailable'));
      if (controller.signal.aborted) { signingKey.fill(0); fail('unavailable', 503); }
      if (JSON.stringify(options.context()) !== identity) { signingKey.fill(0); fail('stale-review'); }
      const { python: _python, ...binding } = context;
      let raw: unknown;
      const invoke = options.invoke ?? ((c: MemoryReviewContext, r: Request, o: { signal?: AbortSignal }) => invokeOwnedMemoryReview(c, r, { ...o, dataDir: dataDirectory }));
      try { dispatched = true; raw = await invoke(context, { ...binding, ...input, version: 1, key: signingKey.toString('base64') }, { signal: controller.signal }); }
      finally { signingKey.fill(0); }
      if (controller.signal.aborted) fail('unavailable', 503);
      checkOwner();
      if (JSON.stringify(options.context()) !== identity) fail('stale-review');
      if (!object(raw) || typeof raw.ok !== 'boolean') fail('unavailable');
      if (!raw.ok) {
        if (exact(raw, ['ok', 'code']) && typeof raw.code === 'string' && Object.hasOwn(MEMORY_REVIEW_ERRORS, raw.code)) {
          // Explicit native policy refusals are useful. An unreadable response
          // or generic helper/storage failure cannot prove a decision failed.
          classifiedRefusal = !['unavailable', 'unsafe-storage', 'capacity'].includes(raw.code);
          fail(raw.code as MemoryReviewErrorCode);
        }
        fail('unavailable');
      }
      if (!exact(raw, ['ok', 'result'])) fail('unavailable');
      if (input.command === 'interrupted-list') {
        const page = parseMemoryRecoveryPage(raw.result);
        if (!page || page.items.some(row => row.key <= (input.cursor ?? ''))) fail('unavailable');
        return page;
      }
      if (input.command === 'interrupted-close') {
        const closed = parseMemoryRecoveryClosure(raw.result);
        if (!closed || closed.key !== input.proposalKey || closed.recoveryDigest !== input.expectedDigest) fail('recovery-required');
        return closed;
      }
      if (input.command === 'propose') {
        const proposal = parseMemoryProposalResult(raw.result); if (!proposal) fail('recovery-required');
        return proposal;
      }
      if (input.command === 'list') { const page = parseMemoryReviewPage(raw.result); if (!page) fail('unavailable'); return page; }
      if (input.command === 'preview') {
        const preview = parseMemoryReviewPreview(raw.result); if (!preview || preview.id !== input.id) fail('unavailable');
        if ([preview.before, preview.after].some(text => containsCredential(text) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(text))) fail('blocked-content');
        return preview;
      }
      const decision = parseMemoryReviewDecision(raw.result);
      if (!decision || decision.id !== input.id || decision.reviewDigest !== input.expectedDigest || decision.state !== (input.decision === 'approve' ? 'applied' : 'rejected')) fail('recovery-required');
      return decision;
    } catch (error) {
      if (mutating(input) && dispatched && !classifiedRefusal) fail('recovery-required', 503);
      throw error;
    } finally { owner?.signal.removeEventListener('abort', abort); active.delete(lockId); controllers.delete(controller); drains.delete(drained); finish(); }
  }
  type Saved = Pick<MemoryReviewItem, 'id' | 'state' | 'decision' | 'reviewDigest'>;
  /** Settles policy intents and staged undo removals against saved review state. */
  function settleUndo(row: LearningEntry, item: Saved) {
    // A person rejected the staged removal: the learning stays kept and a new
    // undo starts afresh. Any saved approval removed the kept text.
    if (item.state === 'rejected') { row.undo = null; row.undoAttempts++; }
    else markUndone(row, now());
  }
  async function reconcile(store: ReturnType<typeof learningStore>, items: Saved[]) {
    const saved = await store.read(), byId = new Map(items.map(item => [item.id, item]));
    const finished = (item?: Saved) => !!item && (item.state === 'applied' || item.state === 'rejected');
    const changes = (row: LearningEntry) => row.state === 'intent' ? finished(byId.get(row.reviewId))
      : row.state === 'kept' && !!row.undo?.proposalId && finished(byId.get(row.undo.proposalId));
    if (!saved.entries.some(changes)) return;
    await store.update(current => {
      current.entries = current.entries.flatMap(row => {
        if (!changes(row)) return [row];
        if (row.state === 'kept') { settleUndo(row, byId.get(row.undo!.proposalId!)!); return [row]; }
        const item = byId.get(row.reviewId)!;
        // Only the exact approval this policy dispatched becomes undoable.
        return item.state === 'applied' && item.decision === 'approve' && item.reviewDigest === row.reviewDigest ? [{ ...row, state: 'kept' as const, keptAt: now() }] : [];
      });
    });
  }
  /** Ledger bookkeeping after a person's read or decision never changes that response. */
  async function reconcileQuietly(items: Saved[]) {
    try { await reconcile(learningStore(options.context()), items); } catch { /* held for the next pass or undo */ }
  }
  async function autoReview(budget: number) {
    let context: MemoryReviewContext; try { context = options.context(); } catch { return; }
    const identity = JSON.stringify(context), store = learningStore(context);
    if (holdsIdentity !== identity) { holds.clear(); holdsIdentity = identity; }
    if (!(await store.read()).autoKeep) { holds.clear(); return; }
    const owner = ownerFor(context); let steps = 0;
    const call = <T>(command: Command): Promise<T> => {
      if (closed || waiting || steps++ >= budget) throw STOP;
      const current = exec(() => run(command, owner)); step = current;
      return current.finally(() => { if (step === current) step = null; }) as Promise<T>;
    };
    let cursor: string | undefined;
    try {
      for (let pages = 0; pages < PASS_PAGES; pages++) {
        const page = await call<MemoryReviewPage>({ command: 'list', ...(cursor ? { cursor } : {}) });
        await reconcile(store, page.items);
        for (const item of page.items) {
          if (item.state !== 'pending') { holds.delete(item.id); continue; }
          const key = holdKey(item), held = (code: Parameters<typeof learningHold>[0]) => { holds.set(item.id, { key, hold: learningHold(code) }); };
          // A dispatched policy decision that was never confirmed is never retried.
          if ((await store.read()).entries.some(row => row.reviewId === item.id && row.state === 'intent')) { held('uncertain'); continue; }
          if (holds.get(item.id)?.key === key) continue;
          let preview: MemoryReviewPreview;
          try { preview = await call<MemoryReviewPreview>({ command: 'preview', id: item.id }); }
          catch (error) { if (error === STOP) throw error; held('unchecked'); continue; }
          if (preview.action !== item.action || preview.target !== item.target || preview.createdAt !== item.createdAt) { held('unchecked'); continue; }
          const verdict = classifyLearning(preview, { containsCredential }), text = addedLearningText(preview);
          if (verdict.decision === 'hold' || text === null) { held(verdict.decision === 'hold' ? verdict.code : 'unchecked'); continue; }
          const textDigest = learningTextDigest(text);
          // Persist the policy intent before dispatch; the setting is rechecked here.
          const admitted = await store.update(current => {
            if (!current.autoKeep) return 'off' as const;
            // An undo sticks: the same learning waits for a person from now on.
            if (current.entries.some(row => row.state === 'undone' && row.textDigest === textDigest)) return 'undone' as const;
            if (current.entries.filter(row => row.state !== 'undone').length >= MEMORY_LEARNING_KEPT_LIMIT) return 'capacity' as const;
            if (current.entries.some(row => row.reviewDigest === preview.reviewDigest || row.reviewId === item.id && row.state === 'intent')) return 'uncertain' as const;
            current.entries.push({ reviewId: item.id, reviewDigest: preview.reviewDigest, target: preview.target, text, textDigest, decidedBy: 'policy', policyVersion: 1,
              state: 'intent', at: now(), keptAt: null, undoneAt: null, undo: null, undoAttempts: 0 });
            return 'ok' as const;
          });
          if (admitted === 'off') { holds.clear(); return; }
          if (admitted !== 'ok') { held(admitted); continue; }
          const forget = () => store.update(current => { current.entries = current.entries.filter(row => !(row.reviewDigest === preview.reviewDigest && row.state === 'intent')); });
          let decision: MemoryReviewDecision;
          try { decision = await call<MemoryReviewDecision>({ command: 'decide', id: item.id, expectedDigest: preview.reviewDigest, decision: 'approve' }); }
          catch (error) {
            // run() turns every unclassified post-dispatch failure into
            // recovery-required. Anything else is a definite refusal (before
            // dispatch, or a classified native refusal) and wrote nothing.
            if (error !== STOP && errorCode(error) === 'recovery-required') { held('uncertain'); continue; }
            await forget();
            if (error === STOP) throw error;
            // A changed proposal is previewed afresh next pass; other refusals wait for a person.
            if (errorCode(error) !== 'stale-review' && errorCode(error) !== 'busy') held('unchecked');
            continue;
          }
          holds.delete(item.id);
          await store.update(current => {
            const row = current.entries.find(entry => entry.reviewDigest === preview.reviewDigest && entry.state === 'intent'); if (!row) return;
            if (decision.changed) { row.state = 'kept'; row.keptAt = now(); } else current.entries = current.entries.filter(entry => entry !== row);
          });
        }
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
    } catch (error) { if (error !== STOP) return; }
  }
  function startPass(budget: number): Promise<void> {
    if (closed || waiting || pass) return pass ?? Promise.resolve();
    // Never logs: errors can carry private memory text or paths.
    const current: Promise<void> = autoReview(budget).catch(() => {}).finally(() => { if (pass === current) pass = null; });
    pass = current; return current;
  }
  const interval = options.autoReviewIntervalMs ?? LEARNING_AUTO_REVIEW_MS;
  const timer = interval > 0 ? setInterval(() => { void startPass(INTERVAL_PASS_STEPS); }, interval) : null;
  timer?.unref();
  async function learningContext() {
    if (closed) fail('unavailable', 503);
    const context = options.context(); await (options.validateRuntime ?? validateOwnedMemoryContext)(context);
    if (closed) fail('unavailable', 503);
    if (JSON.stringify(options.context()) !== JSON.stringify(context)) fail('stale-review');
    return context;
  }
  async function setAutoKeep(autoKeep: boolean): Promise<MemoryLearningState> {
    const context = await learningContext(), store = learningStore(context);
    await store.update(current => { current.autoKeep = autoKeep; current.updatedAt = now(); });
    if (!autoKeep) holds.clear();
    return publicLearningState(await store.read());
  }
  /** A person's undo: stage an exact inverse removal, then decide it once. */
  async function undoLearning(digest: string): Promise<MemoryLearningUndo> {
    const context = await learningContext(), store = learningStore(context), owner = ownerFor(context);
    const found = (await store.read()).entries.find(row => row.reviewDigest === digest);
    if (!found) fail('invalid', 404);
    const done = (result: MemoryLearningUndo['result']): MemoryLearningUndo => ({ version: 1, reviewDigest: digest, result });
    if (found.state === 'undone') return done('undone');
    if (found.state !== 'kept' || found.text === null) fail('stale-review');
    const text = found.text;
    const kept = <T>(change: (row: LearningEntry, current: { entries: LearningEntry[] }) => T) => store.update(current => {
      const row = current.entries.find(entry => entry.reviewDigest === digest && entry.state === 'kept'); if (!row) fail('stale-review');
      return change(row, current);
    });
    const setUndo = (undo: LearningUndo | null) => kept(row => { row.undo = undo; });
    // The record is removed so its Undo is no longer offered; memory is untouched.
    const alreadyChanged = async () => { await kept((row, current) => { current.entries = current.entries.filter(entry => entry !== row); }); return done('already-changed'); };
    /** A person may have decided the staged removal on the review screen. */
    const settleFromSaved = async (proposalId: string, error: unknown): Promise<MemoryLearningUndo> => {
      const prior = Number.parseInt(proposalId, 16) - 1, cursor = prior < 0 ? undefined : prior.toString(16).padStart(8, '0');
      const page = await run({ command: 'list', ...(cursor ? { cursor } : {}) }, owner) as MemoryReviewPage;
      const item = page.items.find(row => row.id === proposalId);
      if (!item || item.state !== 'applied' && item.state !== 'rejected') throw error;
      await kept(row => settleUndo(row, item));
      if (item.state === 'applied') return done('undone');
      fail('stale-review');
    };
    const requestId = `undo-${digest.slice(0, 32)}-${found.undoAttempts}`;
    let undo: LearningUndo = found.undo ?? { requestId, state: 'proposing', proposalId: null, proposalDigest: null };
    if (!found.undo) await setUndo(undo);
    if (undo.state === 'proposing') {
      const scopeId = createHash('sha256').update(`realbud-learning-undo-v1\0${context.workspaceId}\0${context.profileId}`).digest('hex');
      let proposal: MemoryProposalResult;
      // Same request identity on retry: the helper returns the already staged removal.
      try { proposal = await run({ command: 'propose', scopeId, input: { requestId: undo.requestId, payload: { target: found.target, action: 'remove', old_text: text } } }, owner) as MemoryProposalResult; }
      catch (error) { if (errorCode(error) === 'conflict') return alreadyChanged(); throw error; }
      let preview: MemoryReviewPreview;
      try { preview = await run({ command: 'preview', id: proposal.id }, owner) as MemoryReviewPreview; }
      catch (error) { if (errorCode(error) === 'recovery-required') return settleFromSaved(proposal.id, error); throw error; }
      const exactRemoval = preview.action === 'remove' && preview.target === found.target && preview.operationCount === 1 && exactLearningRemoval(preview.before, preview.after, text);
      undo = { requestId: undo.requestId, state: exactRemoval ? 'deciding' : 'rejecting', proposalId: proposal.id, proposalDigest: preview.reviewDigest };
      await setUndo(undo);
    }
    try { await run({ command: 'decide', id: undo.proposalId!, expectedDigest: undo.proposalDigest!, decision: undo.state === 'deciding' ? 'approve' : 'reject' }, owner); }
    catch (error) {
      if (errorCode(error) === 'stale-review') await setUndo({ requestId: undo.requestId, state: 'proposing', proposalId: null, proposalDigest: null });
      // The saved receipt holds a different decision: a person decided it first.
      if (errorCode(error) === 'conflict') return settleFromSaved(undo.proposalId!, error);
      throw error;
    }
    if (undo.state === 'rejecting') return alreadyChanged();
    await kept(row => markUndone(row, now()));
    return done('undone');
  }
  function withHolds(page: MemoryReviewPage): MemoryReviewPage {
    let identity = ''; try { identity = JSON.stringify(options.context()); } catch { return page; }
    if (identity !== holdsIdentity || !holds.size) return page;
    return { ...page, items: page.items.map(item => {
      const held = item.state === 'pending' ? holds.get(item.id) : undefined;
      return held?.key === holdKey(item) ? { ...item, hold: held.hold } : item;
    }) };
  }
  return {
    async close() {
      closed = true; if (timer) clearInterval(timer);
      for (const controller of controllers) controller.abort();
      await Promise.allSettled([...drains, pass]); await Promise.allSettled([...drains]);
    },
    /** Host-only capability: no HTTP route or model-supplied identity can create it. */
    proposalIntegration(threadId: string, isCurrent: () => boolean): { scope: string; propose(input: MemoryProposalInput, signal: AbortSignal): Promise<MemoryProposalResult> } | null {
      if (closed || process.platform === 'win32' || !threadId || threadId.length > 200 || /[\x00-\x1f\x7f]/.test(threadId)) return null;
      let captured: MemoryReviewContext;
      try { captured = { ...options.context() }; } catch { return null; }
      const identity = JSON.stringify(captured), memberKey = currentWorkerProfile().memberKey;
      // Stable across updates and relocation: workspace, member profile and conversation only.
      const scope = createHash('sha256').update(JSON.stringify(['realbud-memory-proposal-scope-v2', captured.workspaceId, captured.profileId, threadId])).digest('hex');
      // A 0.1.42 conversation bound its proposals to the helper's runtime context; retries find
      // those journals only through this binding, verified by their signatures.
      const legacyScopeIds: string[] = [];
      try {
        const legacy = (options.legacyContext ?? nativeMemoryReviewContext)(captured.workspaceId);
        if (legacy.workspaceId === captured.workspaceId && legacy.profileId === captured.profileId)
          legacyScopeIds.push(createHash('sha256').update(JSON.stringify(['realbud-memory-proposal-scope-v1', JSON.stringify(legacy), threadId])).digest('hex'));
      } catch { /* no helper-era runtime: nothing to look up */ }
      return { scope, propose: async (raw, signal) => withWorkerProfile(memberKey, async () => {
        const input = parseMemoryProposalInput(raw); if (!input) fail('invalid', 400);
        if (containsCredential(JSON.stringify(input))) fail('blocked-content');
        const work = () => run({ command: 'propose', scopeId: scope, input, ...(legacyScopeIds.length ? { legacyScopeIds } : {}) }, { signal, context: identity, isCurrent });
        const result = options.withActivity ? await options.withActivity(work) : await work();
        const proposal = parseMemoryProposalResult(result); if (!proposal) fail('recovery-required');
        return proposal;
      }) };
    },
    async handle(path: string, method: string, body?: unknown, query = new URLSearchParams()) {
      if (path !== MEMORY_REVIEW_API && !path.startsWith(`${MEMORY_REVIEW_API}/`)) return null;
      try {
        if (path === MEMORY_LEARNING_API || path.startsWith(`${MEMORY_LEARNING_API}/`)) {
          if (query.size) fail('invalid', 400);
          if (path === MEMORY_LEARNING_API && method === 'GET') {
            if (body !== undefined) fail('invalid', 400);
            return { status: 200, body: await asPerson(() => exec(async () => publicLearningState(await learningStore(await learningContext()).read()))) };
          }
          if (path === MEMORY_LEARNING_API && method === 'POST') {
            if (!object(body) || !exact(body, ['autoKeep']) || typeof body.autoKeep !== 'boolean') fail('invalid', 400);
            const autoKeep = body.autoKeep;
            return { status: 200, body: await asPerson(() => exec(() => setAutoKeep(autoKeep))) };
          }
          const rest = path.slice(MEMORY_LEARNING_API.length + 1).split('/');
          if (rest.length !== 2 || !memoryReviewDigest(rest[0]) || rest[1] !== 'undo' || method !== 'POST') fail('invalid', 404);
          if (!object(body) || Object.keys(body).length) fail('invalid', 400);
          return { status: 200, body: await asPerson(() => exec(() => undoLearning(rest[0]))) };
        }
        let command: Command;
        if (path === MEMORY_RECOVERY_API && method === 'GET') {
          if ([...query.keys()].some(key => key !== 'cursor') || query.getAll('cursor').length > 1) fail('invalid', 400);
          const cursor = query.get('cursor'); if (cursor !== null && !memoryReviewDigest(cursor)) fail('invalid', 400);
          command = { command: 'interrupted-list', ...(cursor ? { cursor } : {}) };
        } else if (path.startsWith(`${MEMORY_RECOVERY_API}/`)) {
          const rest = path.slice(MEMORY_RECOVERY_API.length + 1).split('/');
          if (query.size || rest.length !== 2 || !memoryReviewDigest(rest[0]) || rest[1] !== 'close' || method !== 'POST') fail('invalid', 404);
          if (!object(body) || !exact(body, ['expectedDigest']) || !memoryReviewDigest(body.expectedDigest)) fail('invalid', 400);
          command = { command: 'interrupted-close', proposalKey: rest[0], expectedDigest: body.expectedDigest };
        } else if (path === MEMORY_REVIEW_API && method === 'GET') {
          if ([...query.keys()].some(key => key !== 'cursor') || query.getAll('cursor').length > 1) fail('invalid', 400);
          const cursor = query.get('cursor'); if (cursor !== null && !memoryReviewId(cursor)) fail('invalid', 400);
          command = { command: 'list', ...(cursor ? { cursor } : {}) };
        } else {
          if (query.size) fail('invalid', 400);
          const rest = path.slice(MEMORY_REVIEW_API.length + 1).split('/'); if (!memoryReviewId(rest[0])) fail('invalid', 404);
          if (rest.length === 1 && method === 'GET') command = { command: 'preview', id: rest[0] };
          else if (rest.length === 2 && rest[1] === 'decision' && method === 'POST') {
            if (!object(body) || !exact(body, ['expectedDigest', 'decision']) || !memoryReviewDigest(body.expectedDigest) || body.decision !== 'approve' && body.decision !== 'reject') fail('invalid', 400);
            command = { command: 'decide', id: rest[0], expectedDigest: body.expectedDigest, decision: body.decision };
          } else fail('invalid', 404);
        }
        if (method === 'GET' && body !== undefined) fail('invalid', 400);
        if (command.command === 'list') {
          // Reading the list lets auto-keep run a short pass first, in turn.
          waiting++; try { await settle(); } finally { waiting--; }
          await startPass(LIST_PASS_STEPS);
          const listed = command;
          return { status: 200, body: withHolds(await asPerson(() => exec(async () => {
            const page = await run(listed) as MemoryReviewPage; await reconcileQuietly(page.items); return page;
          }))) };
        }
        const human = command;
        const result = await asPerson(() => exec(async () => {
          const value = await run(human);
          // A person's decision may settle a policy intent or a staged undo removal.
          if (human.command === 'decide') {
            const saved = value as MemoryReviewDecision;
            await reconcileQuietly([{ id: saved.id, state: saved.state, decision: human.decision, reviewDigest: saved.reviewDigest }]);
          }
          return value;
        }));
        return { status: 200, body: result };
      } catch (error) {
        const code = (error as { code?: unknown })?.code;
        const known = typeof code === 'string' && Object.hasOwn(MEMORY_REVIEW_ERRORS, code) ? code as MemoryReviewErrorCode : 'unavailable';
        const rawStatus = (error as { status?: number })?.status, status = [400, 404, 409, 503].includes(rawStatus ?? 0) ? rawStatus! : 503;
        return { status, body: { error: MEMORY_REVIEW_ERRORS[known], code: known } };
      }
    },
  };
}
