Review only the supplied TypeScript/React service and UI boundaries for concrete correctness/security bugs. No tools, external research, filesystem edits, or private user data. The native helper implementation is not supplied and not within this review. Assume its documented CAS protocol; do not invent defects in unavailable code. Focus on request/profile authority, malformed output, lost responses, duplicate decisions, shutdown lifecycle, and literal review UX. Return JSON {verdict:"approved"|"changes-required",findings:[{severity:"high"|"medium",file:string,detail:string,fix:string}],limits:[string]}. Use findings only for demonstrable defects, not broad hypothetical risk. Other agents are working; no modifications.

FILE shared/hermes-memory-review.ts
/** Pending worker preferences are separate from business facts and approvals. */
export const MEMORY_REVIEW_API = '/api/hermes/memory-reviews';
export const MEMORY_REVIEW_ERRORS = {
  invalid: 'This memory review request is not supported.',
  unavailable: 'Memory review is unavailable. Check Bud setup and try again.',
  'unsafe-storage': 'Memory files need service review. Existing files were preserved.',
  unsupported: 'This worker or proposal format needs an update before it can be reviewed.',
  'stale-review': 'The proposal or saved memory changed. Refresh and review the complete change again.',
  conflict: 'The saved result differs from this review. Existing memory and recovery records were preserved.',
  busy: 'Another memory review is running. Wait for it to finish, then refresh.',
  disabled: 'This memory target is disabled in Bud settings. No change was applied.',
  capacity: 'This proposal exceeds the supported memory limit. Ask Bud to prepare a smaller change.',
  'blocked-content': 'This change contains content that cannot be shown or approved here. Existing files were preserved.',
  'recovery-required': 'This memory decision needs recovery. Refresh its saved state before retrying.',
} as const;
export type MemoryReviewErrorCode = keyof typeof MEMORY_REVIEW_ERRORS;
export type MemoryReviewAction = 'add' | 'replace' | 'remove' | 'batch';
export type MemoryReviewTarget = 'memory' | 'user';
export type MemoryReviewOrigin = 'foreground' | 'background_review';
export interface MemoryReviewItem {
  id: string; state: 'pending' | 'applied' | 'rejected' | 'recovery-required' | 'unavailable';
  action: MemoryReviewAction | null; target: MemoryReviewTarget | null; origin: MemoryReviewOrigin | null; createdAt: number | null;
  decision: 'approve' | 'reject' | null; reviewDigest: string | null;
}
export interface MemoryReviewPage { version: 1; items: MemoryReviewItem[]; nextCursor: string | null; total: number; held: number }
export interface MemoryReviewPreview {
  version: 1; id: string; target: MemoryReviewTarget; action: MemoryReviewAction; origin: MemoryReviewOrigin;
  createdAt: number; reviewDigest: string; before: string; after: string; operationCount: number; charLimit: number;
}
export interface MemoryReviewDecision { version: 1; id: string; state: 'applied' | 'rejected'; reviewDigest: string; changed: boolean; at: number }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fields = (v: Record<string, unknown>, names: string[]) => Object.keys(v).length === names.length && names.every(name => Object.hasOwn(v, name));
const integer = (v: unknown, min = 0) => Number.isSafeInteger(v) && Number(v) >= min;
const timestamp = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 8.64e15;
export const memoryReviewId = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}$/.test(v);
export const memoryReviewDigest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const action = (v: unknown) => typeof v === 'string' && ['add', 'replace', 'remove', 'batch'].includes(v);
const target = (v: unknown) => v === 'memory' || v === 'user';
const origin = (v: unknown) => v === 'foreground' || v === 'background_review';
export function parseMemoryReviewPage(v: unknown): MemoryReviewPage | null {
  if (!object(v) || !fields(v, ['version', 'items', 'nextCursor', 'total', 'held']) || v.version !== 1 || !Array.isArray(v.items) || v.items.length > 20 ||
    !integer(v.total) || !integer(v.held) || Number(v.held) > Number(v.total) || v.items.length > Number(v.total) || v.nextCursor !== null && !memoryReviewId(v.nextCursor)) return null;
  const ids = new Set<string>();
  for (const row of v.items) {
    if (!object(row) || !fields(row, ['id', 'state', 'action', 'target', 'origin', 'createdAt', 'decision', 'reviewDigest']) || !memoryReviewId(row.id) || ids.has(row.id) ||
      typeof row.state !== 'string' || !['pending', 'applied', 'rejected', 'recovery-required', 'unavailable'].includes(row.state) || row.action !== null && !action(row.action) ||
      row.target !== null && !target(row.target) || row.origin !== null && !origin(row.origin) || row.createdAt !== null && !timestamp(row.createdAt) ||
      row.decision !== null && row.decision !== 'approve' && row.decision !== 'reject' || row.reviewDigest !== null && !memoryReviewDigest(row.reviewDigest) ||
      (row.decision === null) !== (row.reviewDigest === null) || row.state === 'pending' && row.decision !== null) return null;
    ids.add(row.id);
  }
  return structuredClone(v) as unknown as MemoryReviewPage;
}
export function parseMemoryReviewPreview(v: unknown): MemoryReviewPreview | null {
  if (!object(v) || !fields(v, ['version', 'id', 'target', 'action', 'origin', 'createdAt', 'reviewDigest', 'before', 'after', 'operationCount', 'charLimit']) ||
    v.version !== 1 || !memoryReviewId(v.id) || !target(v.target) || !action(v.action) || !origin(v.origin) || !timestamp(v.createdAt) || !memoryReviewDigest(v.reviewDigest) ||
    typeof v.before !== 'string' || typeof v.after !== 'string' || new TextEncoder().encode(v.before).byteLength > 131_072 || new TextEncoder().encode(v.after).byteLength > 131_072 ||
    !integer(v.operationCount, 1) || Number(v.operationCount) > 100 || !integer(v.charLimit, 1) || Number(v.charLimit) > 100_000 ||
    [...v.after].length > Number(v.charLimit) && (v.action !== 'remove' || [...v.after].length >= [...v.before].length)) return null;
  return { ...v } as unknown as MemoryReviewPreview;
}
export function parseMemoryReviewDecision(v: unknown): MemoryReviewDecision | null {
  if (!object(v) || !fields(v, ['version', 'id', 'state', 'reviewDigest', 'changed', 'at']) || v.version !== 1 || !memoryReviewId(v.id) ||
    typeof v.state !== 'string' || !['applied', 'rejected'].includes(v.state) || !memoryReviewDigest(v.reviewDigest) || typeof v.changed !== 'boolean' ||
    v.state === 'rejected' && v.changed || !timestamp(v.at)) return null;
  return { ...v } as unknown as MemoryReviewDecision;
}

FILE server/hermes-memory-review.ts
/** RealBud owns review authority; the selected native store owns memory rules. */
import { createHash, createHmac } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentWorkerProfile } from './hermes-profile.ts';
import { hermesHome, runtimeCli } from './hermes-paths.ts';
import { propertyProfileDir } from './hermes-pack.ts';
import { readRuntimeSelection, releaseHome, runtimeCommit, selectedHermesCli } from './hermes-runtime-selection.ts';
import { spawnCli, killCliTree } from './procs.ts';
import { containsCredential } from './redact.ts';
import { windowsFilePrivacy } from './windows-file-privacy.ts';
import { MEMORY_REVIEW_API, MEMORY_REVIEW_ERRORS, memoryReviewId, memoryReviewDigest,
  parseMemoryReviewPage, parseMemoryReviewPreview, parseMemoryReviewDecision,
  type MemoryReviewErrorCode } from '../shared/hermes-memory-review.ts';
import type { WorkspaceActivity } from './workspace-activity.ts';

export const MEMORY_REVIEW_RUNTIME = '345cd2b057a452236de401d3534b8502a7465e8d';
export const MEMORY_REVIEW_NATIVE_FILES = {
  'tools/memory_tool.py': 'ed9c5db6b3144b88425f7039280239b29a047143aa8ffdfd3b7f47bf7e707143',
  'tools/memory_tool_store.py': '811ef2eb98a8b3f0448294b2c23d422ff7ebd4dc45835475b12df0557d7e5366',
  'tools/write_approval.py': '9404792bc8c6637e5bd78a87f5a6dfabda6cd6a1a61083b450647ddb2951c470',
  'tools/threat_patterns.py': '6ad8947a5a62db44f66b1cd33086e2b51c4a66019ef5301856e5efae59797341',
  'utils.py': '1414f177e14940750ad80d6dd5020685219ca26b0b7d500299ab2f170118ed07',
  'hermes_constants.py': 'e5f72a309b3689f5fa2e85065e8051f8e6f7686d1ec1741e7543cc5e56bea162',
} as const;
export interface MemoryReviewContext { profileDirectory: string; runtimeDirectory: string; workspaceId: string; profileId: string; runtimeId: string; python: string }
type Command = { command: 'list'; cursor?: string } | { command: 'preview'; id: string } | { command: 'decide'; id: string; expectedDigest: string; decision: 'approve' | 'reject' };
type Request = Omit<MemoryReviewContext, 'python'> & Command & { version: 1; key: string };
const helper = fileURLToPath(new URL('./helpers/hermes-memory-review.py', import.meta.url));
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
function fail(code: MemoryReviewErrorCode, status = code === 'unavailable' ? 503 : 409): never { throw Object.assign(new Error(MEMORY_REVIEW_ERRORS[code]), { code, status }); }
const samePath = (a: string, b: string) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
export function memoryReviewContext(workspaceId: string): MemoryReviewContext {
  const home = hermesHome(), selection = readRuntimeSelection(home).selected;
  if (!selection || runtimeCommit(selection) !== MEMORY_REVIEW_RUNTIME) fail('unsupported');
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
async function validateRuntime(context: MemoryReviewContext) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(context.workspaceId) || !/^property(?:-[a-z0-9-]+)?$/.test(context.profileId) || context.profileId.length > 64 || runtimeCommit(context.runtimeId) !== MEMORY_REVIEW_RUNTIME) fail('unsupported');
  await ancestors(context.profileDirectory);
  for (const [name, expected] of Object.entries(MEMORY_REVIEW_NATIVE_FILES)) if (await digestFile(join(context.runtimeDirectory, name)) !== expected) fail('unsupported');
  await windowsFilePrivacy(context.profileDirectory, 'directory');
}
export function memoryReviewChildEnvironment(context: MemoryReviewContext, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP']) if (source[name]) env[name] = source[name];
  env.HERMES_HOME = context.profileDirectory; env.HERMES_SKIP_DOTENV = '1'; env.PYTHONDONTWRITEBYTECODE = '1';
  return env;
}
/** Resolve only after the owned helper exits; a deadline never means applied. */
export function runMemoryReviewHelper(context: MemoryReviewContext, request: Request, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<unknown> {
  return new Promise((accept, reject) => {
    if (options.signal?.aborted) { reject(Object.assign(new Error(MEMORY_REVIEW_ERRORS.unavailable), { code: 'unavailable', status: 503 })); return; }
    const child = spawnCli(context.python, ['-I', '-B', helper], { cwd: context.runtimeDirectory, env: memoryReviewChildEnvironment(context), stdio: ['pipe', 'pipe', 'pipe'], privateFiles: true });
    let size = 0, killed = false, spawnFailed = false, force: ReturnType<typeof setTimeout> | undefined;
    const chunks: Buffer[] = [];
    const stop = () => { if (killed) return; killed = true; killCliTree(child); force = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 2000); force.unref(); };
    const timer = setTimeout(stop, options.timeoutMs ?? 20_000); timer.unref();
    options.signal?.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 1024 * 1024) { stop(); return; } chunks.push(Buffer.from(chunk)); });
    // Native diagnostics can contain private text. Consume without logging.
    child.stderr.on('data', () => {}); child.on('error', () => { spawnFailed = true; });
    child.once('close', code => {
      clearTimeout(timer); if (force) clearTimeout(force);
      options.signal?.removeEventListener('abort', stop);
      const buffer = Buffer.concat(chunks); for (const chunk of chunks) chunk.fill(0);
      try {
        if (killed || spawnFailed || code !== 0) fail(request.command === 'decide' ? 'recovery-required' : 'unavailable', 503);
        accept(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)));
      } catch (error) { reject(error); } finally { buffer.fill(0); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}
export function createHermesMemoryReviewService(options: {
  context: () => MemoryReviewContext; key: () => Buffer; withActivity?: WorkspaceActivity;
  /** Trusted test seams, never serialized or available through HTTP. */
  validateRuntime?: typeof validateRuntime; invoke?: typeof runMemoryReviewHelper;
}) {
  const active = new Set<string>(), controllers = new Set<AbortController>(), drains = new Set<Promise<void>>();
  let closed = false;
  async function run(input: Command) {
    if (closed) fail('unavailable', 503);
    const context = options.context(), identity = JSON.stringify(context);
    const lockId = process.platform === 'win32' ? resolve(context.profileDirectory).toLowerCase() : resolve(context.profileDirectory);
    if (active.has(lockId)) fail('busy');
    const controller = new AbortController(); controllers.add(controller);
    let finish!: () => void;
    const drained = new Promise<void>(done => { finish = done; }); drains.add(drained);
    active.add(lockId);
    try {
      await (options.validateRuntime ?? validateRuntime)(context);
      if (controller.signal.aborted) fail('unavailable', 503);
      if (JSON.stringify(options.context()) !== identity) fail('stale-review');
      const sourceKey = options.key(); if (!Buffer.isBuffer(sourceKey) || sourceKey.length !== 32) fail('unavailable');
      const signingKey = createHmac('sha256', sourceKey).update(`realbud-memory-review-v1\0${context.workspaceId}\0${context.profileId}`).digest();
      const { python: _python, ...binding } = context;
      let raw: unknown;
      try { raw = await (options.invoke ?? runMemoryReviewHelper)(context, { ...binding, ...input, version: 1, key: signingKey.toString('base64') }, { signal: controller.signal }); }
      finally { signingKey.fill(0); }
      if (JSON.stringify(options.context()) !== identity) fail('stale-review');
      if (!object(raw) || typeof raw.ok !== 'boolean') fail('unavailable');
      if (!raw.ok) { if (exact(raw, ['ok', 'code']) && typeof raw.code === 'string' && Object.hasOwn(MEMORY_REVIEW_ERRORS, raw.code)) fail(raw.code as MemoryReviewErrorCode); fail('unavailable'); }
      if (!exact(raw, ['ok', 'result'])) fail('unavailable');
      if (input.command === 'list') { const page = parseMemoryReviewPage(raw.result); if (!page) fail('unavailable'); return page; }
      if (input.command === 'preview') {
        const preview = parseMemoryReviewPreview(raw.result); if (!preview || preview.id !== input.id) fail('unavailable');
        if ([preview.before, preview.after].some(text => containsCredential(text) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(text))) fail('blocked-content');
        return preview;
      }
      const decision = parseMemoryReviewDecision(raw.result);
      if (!decision || decision.id !== input.id || decision.reviewDigest !== input.expectedDigest || decision.state !== (input.decision === 'approve' ? 'applied' : 'rejected')) fail('recovery-required');
      return decision;
    } finally { active.delete(lockId); controllers.delete(controller); drains.delete(drained); finish(); }
  }
  return {
    async close() { closed = true; for (const controller of controllers) controller.abort(); await Promise.allSettled([...drains]); },
    async handle(path: string, method: string, body?: unknown, query = new URLSearchParams()) {
      if (path !== MEMORY_REVIEW_API && !path.startsWith(`${MEMORY_REVIEW_API}/`)) return null;
      try {
        let command: Command;
        if (path === MEMORY_REVIEW_API && method === 'GET') {
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
        const result = options.withActivity ? await options.withActivity(() => run(command)) : await run(command);
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

FILE src/components/MemoryReviewPanel.tsx
import { useEffect, useState, useSyncExternalStore } from 'react';
import { api } from '@/state/store';
import {
  MEMORY_REVIEW_API, MEMORY_REVIEW_ERRORS,
  parseMemoryReviewPage, parseMemoryReviewPreview, parseMemoryReviewDecision,
  type MemoryReviewItem, type MemoryReviewPage, type MemoryReviewPreview,
} from '@shared/hermes-memory-review';
import { Card } from './SettingsPrimitives';

type Request = (path: string, init?: RequestInit) => Promise<unknown>;
type Decision = 'approve' | 'reject';
type ReviewState = {
  items: MemoryReviewItem[]; cursor: string | null; total: number; held: number; loaded: boolean;
  selected: MemoryReviewItem | null; missing: boolean; preview: MemoryReviewPreview | null; confirmed: boolean;
  busy: 'list' | 'preview' | 'decision' | null; error: string; notice: string;
};
const unknownResult = 'The decision result could not be confirmed. Check saved reviews before trying again.';
const missingResult = 'This review is no longer listed. Its result cannot be confirmed here.';
const states: Record<MemoryReviewItem['state'], string> = {
  pending: 'Ready for review', applied: 'Saved', rejected: 'Rejected',
  'recovery-required': 'Needs recovery', unavailable: 'Needs service review',
};
const targets = { memory: 'Bud’s working preferences', user: 'Your preferences' };
const origins = { foreground: 'Proposed in a conversation', background_review: 'Proposed during a background review' };
const actions = { add: 'Add', replace: 'Replace', remove: 'Remove', batch: 'Combined change' };
const button = 'min-h-11 rounded border border-line bg-sheet px-3 py-2 text-sm text-ink disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-agency';

function safeError(cause: unknown): string {
  if (cause instanceof Error) {
    // Never interpolate transport errors, file paths, account names or unknown server fields.
    const known = Object.values(MEMORY_REVIEW_ERRORS).find(message => message === cause.message);
    if (known) return known;
  }
  return MEMORY_REVIEW_ERRORS.unavailable;
}
function pageResponse(raw: unknown, cursor: string | null): MemoryReviewPage {
  const page = parseMemoryReviewPage(raw);
  if (!page || page.items.some((item, index) => item.id <= (index ? page.items[index - 1].id : cursor ?? '')) ||
    page.nextCursor !== null && page.nextCursor !== page.items.at(-1)?.id) throw new Error(MEMORY_REVIEW_ERRORS.unavailable);
  return page;
}

/** Coordinates this screen's reads and single decisions. Persisted server state owns the result. */
export class MemoryReviewSession {
  private state: ReviewState = { items: [], cursor: null, total: 0, held: 0, loaded: false, selected: null, missing: false, preview: null, confirmed: false, busy: null, error: '', notice: '' };
  private listeners = new Set<() => void>();
  private revision = 0;
  private active = true;
  private deciding = false;
  private uncertain = new Set<string>();
  constructor(private request: Request = (path, init) => api(path, init, { timeoutMs: 15_000 })) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(change: Partial<ReviewState>) { if (!this.active) return; this.state = { ...this.state, ...change }; this.listeners.forEach(listener => listener()); }
  private current(version: number) { return this.active && this.revision === version; }
  start() { this.active = true; void this.readPage(false); }
  stop() { this.active = false; this.revision++; }
  confirm(value: boolean) { this.update({ confirmed: !!this.state.preview && !this.state.busy && !this.state.missing && value }); }

  async refresh(more = false) {
    if (this.deciding || more && (!this.state.cursor || this.state.busy)) return;
    await this.readPage(more);
  }
  private async readPage(more: boolean, afterFailure = '') {
    const version = ++this.revision, cursor = more ? this.state.cursor : null, selectedId = this.state.selected?.id;
    this.update({ preview: null, confirmed: false, busy: 'list', error: '', notice: afterFailure });
    try {
      const page = pageResponse(await this.request(`${MEMORY_REVIEW_API}${cursor ? `?cursor=${cursor}` : ''}`), cursor);
      if (!this.current(version)) return;
      let selected = selectedId ? page.items.find(item => item.id === selectedId) ?? null : null;
      // IDs and cursors are stable ordered identifiers. One additional bounded page finds
      // the selected receipt without walking the entire history after a lost response.
      if (selectedId && !selected) {
        const prior = Number.parseInt(selectedId, 16) - 1;
        const anchor = prior < 0 ? null : prior.toString(16).padStart(8, '0');
        const focused = pageResponse(await this.request(`${MEMORY_REVIEW_API}${anchor ? `?cursor=${anchor}` : ''}`), anchor);
        if (!this.current(version)) return;
        selected = focused.items.find(item => item.id === selectedId) ?? null;
      }
      if (selected) this.uncertain.delete(selected.id);
      const items = more ? [...this.state.items.filter(item => !page.items.some(row => row.id === item.id)), ...page.items] : page.items;
      this.update({
        items: selected ? items.map(item => item.id === selected.id ? selected : item) : items,
        cursor: page.nextCursor, total: page.total, held: page.held, loaded: true,
        selected: selected ?? this.state.selected, missing: !!selectedId && !selected, busy: null,
        error: selectedId && !selected ? missingResult : selected?.state === 'applied' || selected?.state === 'rejected' ? '' : afterFailure,
        notice: selected?.state === 'applied' ? 'The saved record confirms this memory change was applied. Start a new conversation to use the updated preferences.'
          : selected?.state === 'rejected' ? 'The saved record confirms this proposal was rejected.'
          : afterFailure ? 'Saved reviews checked. Review the current state before continuing.' : 'Saved reviews checked.',
      });
    } catch (cause) {
      if (this.current(version)) this.update({ busy: null, preview: null, confirmed: false, missing: !!selectedId, error: afterFailure || safeError(cause), notice: '' });
    }
  }

  async select(id: string) {
    if (this.deciding || this.state.busy === 'list') return;
    const item = this.state.items.find(row => row.id === id) ?? (this.state.selected?.id === id ? this.state.selected : null);
    if (!item) return;
    const version = ++this.revision;
    this.update({ selected: item, missing: false, preview: null, confirmed: false, busy: null, error: '', notice: '' });
    if (this.uncertain.has(id)) { await this.readPage(false); return; }
    if (item.state !== 'pending') return;
    this.update({ busy: 'preview' });
    try {
      const preview = parseMemoryReviewPreview(await this.request(`${MEMORY_REVIEW_API}/${id}`));
      if (!this.current(version)) return;
      if (!preview || preview.id !== id || preview.target !== item.target || preview.action !== item.action || preview.origin !== item.origin || preview.createdAt !== item.createdAt) throw new Error(MEMORY_REVIEW_ERRORS['stale-review']);
      this.update({ preview, busy: null });
    } catch (cause) {
      if (this.current(version)) this.update({ preview: null, confirmed: false, busy: null, error: safeError(cause) });
    }
  }

  async decide(decision: Decision, resume = false) {
    if (this.deciding || this.state.busy || this.state.missing) return;
    const { selected, preview, confirmed } = this.state;
    if (!selected || this.uncertain.has(selected.id)) return;
    const digest = resume ? selected.reviewDigest : preview?.reviewDigest;
    if (resume ? selected.state !== 'recovery-required' || selected.decision !== decision || !digest
      : selected.state !== 'pending' || !preview || preview.id !== selected.id || decision === 'approve' && !confirmed) return;
    this.deciding = true;
    const version = ++this.revision;
    this.update({ busy: 'decision', confirmed: false, error: '', notice: 'Saving your decision and checking its result…' });
    try {
      const result = parseMemoryReviewDecision(await this.request(`${MEMORY_REVIEW_API}/${selected.id}/decision`, {
        method: 'POST', body: JSON.stringify({ expectedDigest: digest, decision }),
      }));
      if (!this.current(version)) return;
      if (!result || result.id !== selected.id || result.reviewDigest !== digest || result.state !== (decision === 'approve' ? 'applied' : 'rejected')) throw new Error(unknownResult);
      const saved: MemoryReviewItem = { ...selected, state: result.state, decision, reviewDigest: result.reviewDigest };
      this.update({ selected: saved, items: this.state.items.map(item => item.id === saved.id ? saved : item), preview: null, confirmed: false, busy: null,
        notice: result.state === 'applied' ? 'The saved result confirms this memory change was applied. Start a new conversation to use the updated preferences.' : 'This proposal was rejected. Your saved preferences were not changed.' });
    } catch (cause) {
      if (this.current(version)) {
        this.uncertain.add(selected.id);
        this.update({ preview: null, confirmed: false });
        await this.readPage(false, safeError(cause) === MEMORY_REVIEW_ERRORS.unavailable ? unknownResult : safeError(cause));
      }
    } finally { this.deciding = false; }
  }
}

/** A complete literal value, with its own keyboard-scrollable region. */
export function MemoryReviewText({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 space-y-2"><h5 className="text-sm font-medium">{label}</h5>
    {value.length === 0 && <p className="text-sm text-ink-muted">Empty — no saved text.</p>}
    <pre role="region" aria-label={label} tabIndex={0} className="max-h-80 min-h-16 overflow-auto rounded border border-line bg-inset p-3 font-mono text-sm leading-relaxed focus-visible:outline-2 focus-visible:outline-agency" style={{ whiteSpace: 'pre', tabSize: 4 }}>{value}</pre>
    <p className="text-xs text-ink-muted">{[...value].length.toLocaleString()} characters · complete text, with spacing preserved</p>
  </div>;
}

export function MemoryReviewPanel() {
  const [session] = useState(() => new MemoryReviewSession());
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  useEffect(() => { session.start(); return () => session.stop(); }, [session]);
  const { selected, preview, busy } = state;
  return <section aria-label="Bud memory reviews" aria-busy={!!busy}><Card title="Bud’s memory" subtitle="Review what Bud proposes to remember for future conversations.">
    <div className="space-y-4 text-sm">
      <p className="text-ink-secondary">These preferences guide future conversations. They do not update business records or grant permission to do work. Saved changes may require a new conversation.</p>
      <div className="flex flex-wrap items-center justify-between gap-2"><button type="button" className={button} disabled={busy === 'decision'} onClick={() => void session.refresh()}>Refresh memory reviews</button>{state.loaded && <p className="text-ink-muted">{state.items.length} of {state.total} reviews shown</p>}</div>
      {!state.loaded && !state.error && <p role="status">Checking saved memory reviews…</p>}
      {state.loaded && state.items.length === 0 && <p>No saved memory proposals to review. Background reviews can leave proposals here. Conversation additions are reviewed in Ask.</p>}
      {state.held > 0 && <p className="text-hold">{state.held} {state.held === 1 ? 'review needs' : 'reviews need'} attention. Existing memory and recovery records are preserved.</p>}
      {!!state.items.length && <div aria-label="Saved memory reviews" className="divide-y divide-line border-y border-line">{state.items.map(item => <button key={item.id} type="button" className={`flex min-h-14 w-full flex-wrap items-start justify-between gap-2 px-2 py-3 text-left focus-visible:outline-2 focus-visible:outline-agency disabled:opacity-50 ${selected?.id === item.id ? 'bg-selected' : ''}`} disabled={busy === 'decision' || busy === 'list'} aria-pressed={selected?.id === item.id} onClick={() => void session.select(item.id)}><span><span className="block font-medium">{item.target ? targets[item.target] : 'Memory proposal'}{item.action ? ` · ${actions[item.action]}` : ''}</span><span className="block text-xs text-ink-muted">{item.origin ? origins[item.origin] : 'Details unavailable'}{item.createdAt !== null ? ` · ${new Date(item.createdAt).toLocaleString()}` : ''}</span></span><span className="text-xs">{states[item.state]}</span></button>)}</div>}
      {state.cursor && <button type="button" className={button} disabled={!!busy} onClick={() => void session.refresh(true)}>Show more reviews</button>}
      {selected && <section aria-label="Selected memory review" className="min-w-0 space-y-3 border-t border-line pt-4">
        <div><h4 className="font-medium">{selected.target ? targets[selected.target] : 'Memory proposal'} · {states[selected.state]}</h4>{selected.origin && <p className="text-ink-muted">{origins[selected.origin]}</p>}</div>
        {state.missing ? <p>Refresh saved reviews to check this item before continuing.</p>
          : selected.state === 'recovery-required' ? <><p>A saved decision needs to finish. Resuming checks and completes only that recorded decision; it does not approve a different change.</p>{selected.decision && selected.reviewDigest ? <button type="button" className={button} disabled={!!busy} onClick={() => void session.decide(selected.decision!, true)}>Resume saved {selected.decision === 'approve' ? 'approval' : 'rejection'}</button> : <p>Contact your RealBud administrator to review recovery. No new decision is available here.</p>}</>
          : selected.state === 'unavailable' ? <p>These files need service review. Check Bud setup or contact your RealBud administrator. Existing files are preserved.</p>
          : selected.state === 'applied' ? <p>This memory decision is saved. Start a new conversation to use the updated preferences.</p>
          : selected.state === 'rejected' ? <p>This proposal was rejected. It cannot be approved from this review.</p>
          : !preview && busy !== 'preview' && <button type="button" className={button} disabled={!!busy} onClick={() => void session.select(selected.id)}>Review complete change</button>}
        {busy === 'preview' && <p role="status">Loading the complete change…</p>}
        {preview && !state.missing && <>
          <p>{actions[preview.action]} · {preview.operationCount} {preview.operationCount === 1 ? 'operation' : 'operations'} · saved memory limit {preview.charLimit.toLocaleString()} characters</p>
          <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2"><MemoryReviewText label="Before — currently saved" value={preview.before} /><MemoryReviewText label="After — proposed complete text" value={preview.after} /></div>
          <label className="flex min-h-11 items-start gap-2"><input type="checkbox" className="mt-1 size-4 shrink-0" disabled={!!busy} checked={state.confirmed} onChange={event => session.confirm(event.target.checked)} /><span>I reviewed the complete before and after text and approve this exact version once.</span></label>
          <div className="flex flex-wrap gap-2"><button type="button" className={`${button} border-agency bg-agency text-white`} disabled={!!busy || !state.confirmed} onClick={() => void session.decide('approve')}>Apply reviewed change</button><button type="button" className={button} disabled={!!busy} onClick={() => void session.decide('reject')}>Reject this proposal</button></div>
          <p className="text-xs text-ink-muted">This decision applies only to the displayed proposal. It does not create an ongoing approval.</p>
        </>}
      </section>}
      {state.error && <p role="alert" className="text-danger">{state.error}</p>}
      <p role="status" aria-live="polite" className="text-ink-secondary">{busy === 'list' ? 'Checking saved reviews…' : busy === 'decision' ? 'Saving your decision and checking its result…' : state.notice}</p>
    </div>
  </Card></section>;
}
