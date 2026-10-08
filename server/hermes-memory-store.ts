/** RealBud-owned memory semantics: a line-for-line port of the admitted Hermes
 * 0.21.5 built-in store (tools/memory_tool_store.py MemoryStore, memory_tool.py
 * apply_memory_pending, threat_patterns.py strict scope) so reviews need no
 * worker Python. Entries are joined by "\n§\n"; budgets count code points. */

import { createHash } from 'node:crypto';

export const ENTRY_DELIMITER = '\n§\n';
export type MemoryTarget = 'memory' | 'user';
export type StoreCode = 'disabled' | 'blocked-content' | 'capacity' | 'conflict' | 'unsupported' | 'invalid';
export class StoreRefusal extends Error { readonly code: StoreCode; constructor(code: StoreCode) { super(code); this.code = code; } }
function refuse(code: StoreCode): never { throw new StoreRefusal(code); }

export interface MemorySettings { writeApproval: boolean; memoryEnabled: boolean; userEnabled: boolean; memoryLimit: number; userLimit: number }
export type MemoryOp = { action: 'add' | 'replace' | 'remove'; content?: string; old_text?: string; matched_entry?: string };
export type MemoryPayload = { action: 'add' | 'replace' | 'remove'; target: MemoryTarget; content?: string; old_text?: string; matched_entry?: string }
  | { action: 'batch'; target: MemoryTarget; operations: MemoryOp[] };

// Python str.isspace(): JS \s plus \x1c-\x1f and \x85, minus ﻿.
const PY_SPACE = '\\t\\n\\v\\f\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const STRIP = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, 'g');
export const pyStrip = (text: string) => text.replace(STRIP, '');
export const charLength = (text: string) => [...text].length;
export const parseEntries = (raw: string) => raw.split(ENTRY_DELIMITER).map(pyStrip).filter(Boolean);
const joined = (entries: string[]) => entries.join(ENTRY_DELIMITER);
export const targetLimit = (settings: MemorySettings, target: MemoryTarget) => target === 'user' ? settings.userLimit : settings.memoryLimit;
export const targetEnabled = (settings: MemorySettings, target: MemoryTarget) => target === 'user' ? settings.userEnabled : settings.memoryEnabled;

// ── threat_patterns.py, strict scope (all ⊂ context ⊂ strict) ──────────────
const WORD = '[\\p{L}\\p{N}_]';
/** Python's Unicode-aware \w and \b in JS Unicode mode. */
const py = (pattern: string) => new RegExp(pattern.replaceAll('\\b', `(?:(?<=${WORD})(?!${WORD})|(?<!${WORD})(?=${WORD}))`).replaceAll('\\w', WORD), 'iu');
const FILLER = String.raw`(?:\w+\s+){0,8}`;
const SECRET_VAR = String.raw`\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)S?\b`;
const MODIFY = String.raw`(update|modify|edit|write|change|append|add\s+to)\s+[^\n]{0,2048}`;
const THREATS = [
  String.raw`ignore\s+${FILLER}(previous|all|above|prior)\s+${FILLER}instructions`,
  String.raw`system\s+prompt\s+override`,
  String.raw`disregard\s+${FILLER}(your|all|any)\s+${FILLER}(instructions|rules|guidelines)`,
  String.raw`act\s+as\s+(if|though)\s+${FILLER}you\s+${FILLER}(have\s+no|don't\s+have)\s+${FILLER}(restrictions|limits|rules)`,
  String.raw`<!--[^>]{0,512}(?:ignore|override|system|secret|hidden)[^>]{0,512}-->`,
  String.raw`<\s*div\s+style\s*=\s*["'][^>]{0,2048}display\s*:\s*none`,
  String.raw`translate\s+[^\n]{0,512}\s+into\s+\w+(?:[\s-]+\w+){0,2}\s+and\s+(execute|run|eval)\b`,
  String.raw`do\s+not\s+${FILLER}tell\s+${FILLER}the\s+user`,
  String.raw`you\s+are\s+${FILLER}now\s+(?:a|an|the)\s+`,
  String.raw`pretend\s+${FILLER}(you\s+are|to\s+be)\s+`,
  String.raw`output\s+${FILLER}(system|initial)\s+prompt`,
  String.raw`(respond|answer|reply)\s+without\s+${FILLER}(restrictions|limitations|filters|safety)`,
  String.raw`you\s+have\s+been\s+${FILLER}(updated|upgraded|patched)\s+to`,
  String.raw`\bname\s+yourself\s+\w+`,
  String.raw`register\s+(as\s+)?a?\s*node`,
  String.raw`(heartbeat|beacon|check[\s\-]?in)\s+(to|with)\s+`,
  String.raw`pull\s+(down\s+)?(?:new\s+)?task(?:ing|s)?\b`,
  String.raw`connect\s+to\s+the\s+network\b`,
  String.raw`you\s+must\s+(?:\w+\s+){0,3}(register|connect|report|beacon)\b`,
  String.raw`only\s+use\s+one[\s\-]?liners?\b`,
  String.raw`never\s+${FILLER}(?:create|write)\s+${FILLER}(?:script|file)\s+${FILLER}disk`,
  String.raw`unset\s+\w*(?:CLAUDE|CODEX|HERMES|AGENT|OPENAI|ANTHROPIC)\w*`,
  String.raw`\b(?:cobalt\s*strike|sliver|havoc|mythic|metasploit|brainworm)\b`,
  String.raw`\bc2\s+(?:server|channel|infrastructure|beacon)\b`,
  String.raw`\bcommand\s+and\s+control\b`,
  String.raw`curl\s+[^\n]{0,2048}${SECRET_VAR}`,
  String.raw`wget\s+[^\n]{0,2048}${SECRET_VAR}`,
  String.raw`cat\s+[^\n]{0,2048}(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)`,
  String.raw`(send|post|upload|transmit)\s+[^\n]{0,2048}\s+(to|at)\s+https?://`,
  String.raw`(include|output|print|share)\s+${FILLER}(conversation|chat\s+history|previous\s+messages|full\s+context|entire\s+context)`,
  String.raw`authorized_keys`,
  String.raw`(?:\b(?:echo|cat|cp|mv|dd|tee|install|printf|rsync|scp|ln|append|add|write|sed|chmod|chown|truncate|rm|touch|curl|wget|git)\b|\bopen\s*\(|>>?)[^\n]{0,512}(?:\$HOME/\.ssh|~/\.ssh)`,
  String.raw`\$HOME/\.hermes/\.env|~/\.hermes/\.env`,
  String.raw`${MODIFY}(?:AGENTS\.md|CLAUDE\.md|\.cursorrules|\.clinerules)`,
  String.raw`${MODIFY}\.hermes/(config\.yaml|SOUL\.md)`,
  String.raw`(?:api[_-]?key|token|secret|password)\s*[=:]\s*["'](?!(?-i:[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)["'])[A-Za-z0-9+/=_-]{20,}`,
].map(py);
const INVISIBLE = new Set('​‌‍⁠⁢⁣⁤﻿‪‫‬‭‮⁦⁧⁨⁩');
/** True when the text matches an injection/exfiltration pattern (strict scope). */
export function threatFound(content: string): boolean {
  if (!content) return false;
  const text = [...content].slice(0, 65_536).join('');
  if ([...text].some(ch => INVISIBLE.has(ch))) return true;
  const normalised = text.normalize('NFKC');
  return THREATS.some(pattern => pattern.test(normalised));
}

/** Control, bidi and surrogate code points never enter memory. */
export function rejectNewText(text: unknown): void {
  if (typeof text !== 'string') refuse('invalid');
  const value = text as string;
  if (value.includes(ENTRY_DELIMITER)) refuse('blocked-content');
  for (const ch of value) {
    const o = ch.codePointAt(0)!;
    if (o < 32 && ch !== '\t' && ch !== '\n' || o >= 127 && o <= 159 || o >= 0x202a && o <= 0x202e || o >= 0x2066 && o <= 0x2069 || o >= 0xd800 && o <= 0xdfff) refuse('blocked-content');
  }
  if (threatFound(value) || threatFound(pyStrip(value))) refuse('blocked-content');
}

// ── store semantics ─────────────────────────────────────────────────────────
function uniqueMatch(entries: string[], oldText: string): number | null {
  const exact = entries.flatMap((entry, index) => entry === oldText ? [index] : []);
  const matches = exact.length ? exact : entries.flatMap((entry, index) => entry.includes(oldText) ? [index] : []);
  if (new Set(matches.map(index => entries[index])).size > 1) refuse('conflict');
  return matches.length ? matches[0] : null;
}
function locate(entries: string[], oldText: string, matched?: string): number {
  if (matched !== undefined) { const index = entries.indexOf(matched); return index >= 0 ? index : refuse('conflict'); }
  const index = uniqueMatch(entries, oldText);
  return index === null ? refuse('conflict') : index;
}
/** `_mutate`'s reload: exact round trip, no duplicates, and (unless append-only) no oversized entry. */
function loaded(raw: string, limit: number, skipDrift: boolean): string[] {
  const parsed = parseEntries(raw);
  if (new Set(parsed).size !== parsed.length || raw !== joined(parsed)) refuse('conflict');
  if (!skipDrift && parsed.length && Math.max(...parsed.map(charLength)) > limit) refuse('conflict');
  return parsed;
}

/** Resolve each unpinned replace/remove to the full entry it selects in `before`
 * (resolve_entry / resolve_batch_entries), failing exactly where the edit would. */
export function pinEntries(payload: MemoryPayload, before: string, settings: MemorySettings): MemoryPayload {
  const limit = targetLimit(settings, payload.target);
  if (payload.action === 'batch') {
    if (!payload.operations.some(op => op.action !== 'add' && op.matched_entry === undefined)) return payload;
    const matched = runBatch(payload.operations, before, limit, true);
    return { ...payload, operations: payload.operations.map((op, i) => op.action !== 'add' && op.matched_entry === undefined ? { ...op, matched_entry: matched.previous[i]! } : op) };
  }
  if (payload.action === 'add' || payload.matched_entry !== undefined) return payload;
  const oldText = pyStrip(payload.old_text ?? '');
  if (!oldText) refuse('conflict');
  const entries = loaded(before, limit, true);
  return { ...payload, matched_entry: entries[locate(entries, oldText)] };
}

/** `_batch`: empty check, content scan, reload, then the all-or-nothing walk against the final budget. */
function runBatch(ops: MemoryOp[], before: string, limit: number, skipDrift: boolean): { entries: string[]; working: string[]; previous: Array<string | null> } {
  if (!ops.length) refuse('conflict');
  for (const op of ops) if ((op.action === 'add' || op.action === 'replace') && op.content && threatFound(op.content)) refuse('blocked-content');
  const entries = loaded(before, limit, skipDrift), working = [...entries], previous: Array<string | null> = [];
  for (const op of ops) {
    const content = pyStrip(op.content ?? ''), oldText = pyStrip(op.old_text ?? '');
    if (op.action === 'add') {
      if (!content) refuse('conflict');
      if (!working.includes(content)) working.push(content);
      previous.push(null); continue;
    }
    if (!oldText || op.action === 'replace' && !content) refuse('conflict');
    const index = locate(working, oldText, op.matched_entry);
    previous.push(working[index]);
    working.splice(index, 1, ...(op.action === 'replace' ? [content] : []));
  }
  if (entries.length && !working.length) refuse('conflict'); // never empty a store in one batch
  if (charLength(joined(working)) > limit) refuse('capacity');
  return { entries, working, previous };
}

/** apply_memory_pending against `before` without writing. Returns the exact next
 * file text and whether it changed. Every new entry passes the content gate. */
export function applyPending(payload: MemoryPayload, before: string, settings: MemorySettings): { after: string; changed: boolean } {
  const target = payload.target, limit = targetLimit(settings, target);
  if (!targetEnabled(settings, target)) refuse('disabled');
  let entries: string[], next: string[] | null = null;
  if (payload.action === 'batch') {
    if (payload.operations.some(op => op.action !== 'add' && !op.matched_entry)) refuse('unsupported');
    ({ entries, working: next } = runBatch(payload.operations, before, limit, false));
  } else if (payload.action === 'add') {
    const content = pyStrip(payload.content ?? '');
    if (!content) refuse('conflict');
    if (threatFound(content)) refuse('blocked-content');
    entries = loaded(before, limit, true);
    if (!entries.includes(content)) {
      if (charLength(joined([...entries, content])) > limit) refuse('capacity');
      next = [...entries, content];
    }
  } else {
    if (!payload.matched_entry) refuse('unsupported');
    const oldText = pyStrip(payload.old_text ?? ''), content = pyStrip(payload.content ?? '');
    if (!oldText) refuse('conflict');
    if (payload.action === 'replace') { if (!content) refuse('conflict'); if (threatFound(content)) refuse('blocked-content'); }
    entries = loaded(before, limit, false);
    const index = locate(entries, oldText, payload.matched_entry);
    next = [...entries.slice(0, index), ...(payload.action === 'replace' ? [content] : []), ...entries.slice(index + 1)];
    if (payload.action === 'replace' && charLength(joined(next)) > limit) refuse('capacity');
  }
  if (next === null) return { after: before, changed: false };
  for (const entry of next) if (!entries.includes(entry)) rejectNewText(entry);
  const after = joined(next);
  if (after === before) return { after, changed: false };
  if (Buffer.byteLength(after) > 128 * 1024) refuse('capacity');
  return { after, changed: true };
}

// ── staged payload normalization (review helper _norm_payload / _norm_op) ─
const PAYLOAD_KEYS = new Set(['action', 'target', 'content', 'old_text', 'new_text', 'operations', 'matched_entry']);
const OP_KEYS = new Set(['action', 'content', 'old_text', 'new_text', 'matched_entry']);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function alias(content: unknown, newText: unknown): string | undefined {
  const a = content ?? undefined, b = newText ?? undefined;
  if (a !== undefined && typeof a !== 'string' || b !== undefined && typeof b !== 'string') refuse('invalid');
  if (a !== undefined && b !== undefined && a !== b) refuse('unsupported');
  return (a ?? b) as string | undefined;
}
function single(raw: Record<string, unknown>, action: unknown): MemoryOp {
  if (action !== 'add' && action !== 'replace' && action !== 'remove') return refuse('unsupported');
  const content = alias(raw.content, raw.new_text), oldText = raw.old_text ?? undefined;
  if (oldText !== undefined && typeof oldText !== 'string') refuse('invalid');
  const out: MemoryOp = { action };
  if (action === 'add' || action === 'replace') {
    if (content === undefined) refuse('invalid');
    rejectNewText(content); out.content = content;
    if (action === 'replace') { if (oldText === undefined) refuse('invalid'); out.old_text = oldText as string; }
    else if (oldText !== undefined && oldText !== '') refuse('unsupported');
  } else {
    if (content !== undefined && content !== '') refuse('unsupported');
    if (oldText === undefined) refuse('invalid');
    out.old_text = oldText as string;
  }
  if (Object.hasOwn(raw, 'matched_entry')) {
    if (action === 'add') refuse('unsupported');
    if (typeof raw.matched_entry !== 'string' || !raw.matched_entry) refuse('invalid');
    out.matched_entry = raw.matched_entry as string;
  }
  return out;
}
/** A staged payload as the store will replay it. */
export function normalizePayload(raw: unknown): MemoryPayload {
  if (!isObject(raw) || Object.keys(raw).some(key => !PAYLOAD_KEYS.has(key))) return refuse('unsupported');
  const target = raw.target ?? 'memory';
  if (target !== 'memory' && target !== 'user') refuse('unsupported');
  const operations = raw.operations ?? undefined, action = raw.action ?? undefined;
  if (operations !== undefined) {
    if (action !== undefined && action !== 'batch' || ['content', 'old_text', 'new_text', 'matched_entry'].some(key => Object.hasOwn(raw, key))) refuse('unsupported');
    if (!Array.isArray(operations)) refuse('invalid');
    const list = operations as unknown[];
    if (list.length > 100) refuse('capacity');
    if (!list.length) refuse('invalid');
    return { action: 'batch', target: target as MemoryTarget, operations: list.map(op => {
      if (!isObject(op)) return refuse('invalid');
      if (Object.keys(op).some(key => !OP_KEYS.has(key))) refuse('unsupported');
      return single(op, op.action);
    }) };
  }
  return { ...single(raw, action), target: target as MemoryTarget } as MemoryPayload;
}

// ── a worker-side file edit as a reviewable record ──────────────────────────
const OPEN: MemorySettings = { writeApproval: true, memoryEnabled: true, userEnabled: true, memoryLimit: Number.MAX_SAFE_INTEGER, userLimit: Number.MAX_SAFE_INTEGER };
/** A worker's direct edit of MEMORY.md/USER.md as a staged record a person can
 * review: the pinned operations that turn `before` into exactly `after`, or null
 * when no reviewable change yields those bytes. The id follows the edited bytes,
 * so the same edit is never staged twice. Real limits apply at preview. */
export function workerEditRecord(target: MemoryTarget, before: string, after: string, at: number): { id: string; bytes: Buffer } | null {
  const want = parseEntries(after), have = parseEntries(before);
  if (after !== joined(want) || new Set(want).size !== want.length) return null;
  const candidates: MemoryOp[][] = [];
  if (want.length === have.length) candidates.push(have.flatMap((entry, i) => entry === want[i] ? [] : [{ action: 'replace' as const, old_text: entry, content: want[i], matched_entry: entry }]));
  candidates.push([...have.filter(entry => !want.includes(entry)).map(entry => ({ action: 'remove' as const, old_text: entry, matched_entry: entry })),
    ...want.filter(entry => !have.includes(entry)).map(entry => ({ action: 'add' as const, content: entry }))]);
  for (const ops of candidates) {
    if (!ops.length || ops.length > 100) continue;
    const payload: MemoryPayload = ops.length === 1 ? { ...ops[0], target } as MemoryPayload : { action: 'batch', target, operations: ops };
    try { if (applyPending(payload, before, OPEN).after !== after) continue; } catch { continue; }
    const id = createHash('sha256').update(`realbud-worker-memory-edit-v1\0${target}\0`).update(after).digest('hex').slice(0, 8);
    return { id, bytes: Buffer.from(JSON.stringify({ id, subsystem: 'memory', action: payload.action, summary: 'Bud edited its memory file directly. Review the change.',
      origin: 'background_review', created_at: Math.floor(at / 1000), payload }), 'utf8') };
  }
  return null;
}
