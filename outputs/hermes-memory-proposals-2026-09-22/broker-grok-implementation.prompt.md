Implement ONE TypeScript module server/hermes-memory-proposal-broker.ts as a bounded specialist proposal. Do not use tools, edit files, spawn agents, or request more context. Return structured JSON {code:string,designNotes:string[],testCases:string[]} with complete module source. Codex will inspect, integrate and test your proposal. Do not include hidden reasoning.

Contract:
startMemoryProposalBroker({isActive():boolean, propose(input:MemoryProposalInput,signal:AbortSignal):Promise<MemoryProposalResult>, assertCapability?:()=>void}) -> Promise<MemoryProposalBroker> with descriptor {type:'http',name:'memory-proposals',url,headers:[{name:'authorization',value:'Bearer random-token'}]}, cancelPending():void and close():void.
Default assertCapability imports managedService from './managed-service.ts' and calls managedService.assertCapability('reasoning'). Shared types and parsers import '../shared/hermes-memory-proposal.ts'. Exactly one tool memory_propose. Metadata title/description must say proposal only, no memory changed by tool, exact human review in You→Bud→Bud’s memory, retry SAME requestId + payload after an uncertain response. Publish strict discriminated JSON schemas for native payload add/replace/remove/batch; no nested target/batch, unknown keys, aliases, approval tool/digests. Return only validated {version:1,id:8lowerhex,reviewLocation:fixed} as JSON text content/structuredContent. Never expose provider errors, arguments, paths, identity or raw exception data. Fixed safe error strings.

RealBud existing pattern uses node:http createServer bound only127.0.0.1 randomport, private randomBytes32 bearer, POST /mcp JSON-RPC2.0, JSON content responses, initialize returns protocolVersion2024-11-05 tools:{} and serverInfo, tools/list lists metadata, ping {}, notifications/initialized accepted202; no sampling/resources/approval. Validate exact Host 127.0.0.1:ownport, reject ANY Origin header, bearer equality before body; bound request body ~70KiB, JSON-RPC id safe integer or nonempty string max100 (reject controls), require own ids for tools/call so notifications cannot act. Reject malformed fields/params with fixed errors. Handle malformed UTF8 strictly. initialize/tools/list/ping discovery allowed before isActive; tools/call requires active+reasoning before dispatch, after callback and immediately before cached reply.

Concurrency/replay: bounded request cache max256 and bounded retained bytes ~2MiB; no raw proposal text in cache if digest fingerprint sufficient. Cache exact RPC id(type included)+body fingerprint; reject changed-body sameRPCID. Concurrent sameRPCID+body shares one promise. Separate transport ID from input.requestId: native host is authoritative durable idempotency, so a new RPC id with same requestId+payload must reach propose; never fabricate success after unknown. SameRPCID uncertain/error may reuse a fixed uncertain error, not retry dispatch. Check activity/capability before returning a cached tools/call result. Max4 active proposal callbacks. Track controllers; cancelPending increments generation and aborts in-flight, isolates unfinished replay so a new turn can't adopt an old callback result. Do NOT clear unfinished RPC history and redispatch same RPC id. Completed success can replay only if current active+reasoning permit. Callback may ignore abort: release the HTTP response promptly using an abort race but retain live callback accounting until actual settlement; suppress unhandled rejection. close revokes token, aborts and closes ownserver; never hang HTTP. Reject request disconnect without leaking or confirming unknown work. Request body timeout10s. Overall callback timeout35s preferred, non-cooperative callback cannot create unbounded active operations. Root host implements persistent idempotency and native threat/credential checks.

Current shared contract source:
/** Proposals are pending human reviews, never authority to change saved memory. */
export type MemoryProposalOperation =
  | { action: 'add'; content: string }
  | { action: 'replace'; content: string; old_text: string }
  | { action: 'remove'; old_text: string };
export type MemoryProposalPayload = ({ target: 'memory' | 'user' } & MemoryProposalOperation)
  | { target: 'memory' | 'user'; action: 'batch'; operations: MemoryProposalOperation[] };
export interface MemoryProposalInput { requestId: string; payload: MemoryProposalPayload }
export const MEMORY_PROPOSAL_REVIEW_LOCATION = 'You → Bud → Bud’s memory' as const;
export interface MemoryProposalResult { version: 1; id: string; reviewLocation: typeof MEMORY_PROPOSAL_REVIEW_LOCATION }
export const MEMORY_PROPOSAL_INPUT_BYTES = 64 * 1024;
const textBytes = 128 * 1024;
const encoder = new TextEncoder();
const controls = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/;
// With Unicode mode, valid surrogate pairs are a single code point outside this range.
const unpairedSurrogate = /[\ud800-\udfff]/u;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const fields = (value: Record<string, unknown>, names: string[]) => Reflect.ownKeys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && encoder.encode(value).byteLength <= textBytes && !controls.test(value) && !unpairedSurrogate.test(value);
}
function operation(value: unknown, withTarget: boolean): MemoryProposalOperation | null {
  if (!object(value)) return null;
  const extra = withTarget ? ['target'] : [];
  if (value.action === 'add' && fields(value, [...extra, 'action', 'content']) && text(value.content)) return { action: 'add', content: value.content };
  if (value.action === 'replace' && fields(value, [...extra, 'action', 'content', 'old_text']) && text(value.content) && text(value.old_text)) return { action: 'replace', content: value.content, old_text: value.old_text };
  if (value.action === 'remove' && fields(value, [...extra, 'action', 'old_text']) && text(value.old_text)) return { action: 'remove', old_text: value.old_text };
  return null;
}
export function parseMemoryProposalInput(value: unknown): MemoryProposalInput | null {
  if (!object(value) || !fields(value, ['requestId', 'payload']) || typeof value.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value.requestId) || !object(value.payload)) return null;
  const raw = value.payload, target = raw.target;
  if (target !== 'memory' && target !== 'user') return null;
  let payload: MemoryProposalPayload;
  if (raw.action === 'batch') {
    if (!fields(raw, ['target', 'action', 'operations']) || !Array.isArray(raw.operations) || raw.operations.length < 1 || raw.operations.length > 100) return null;
    const operations: MemoryProposalOperation[] = [];
    for (const item of raw.operations) { const parsed = operation(item, false); if (!parsed) return null; operations.push(parsed); }
    payload = { target, action: 'batch', operations };
  } else {
    const parsed = operation(raw, true); if (!parsed) return null;
    payload = { target, ...parsed };
  }
  const parsed = { requestId: value.requestId, payload };
  return encoder.encode(JSON.stringify(parsed)).byteLength <= MEMORY_PROPOSAL_INPUT_BYTES ? parsed : null;
}
export function parseMemoryProposalResult(value: unknown): MemoryProposalResult | null {
  if (!object(value) || !fields(value, ['version', 'id', 'reviewLocation']) || value.version !== 1 || typeof value.id !== 'string' || !/^[a-f0-9]{8}$/.test(value.id) || value.reviewLocation !== MEMORY_PROPOSAL_REVIEW_LOCATION) return null;
  return { version: 1, id: value.id, reviewLocation: MEMORY_PROPOSAL_REVIEW_LOCATION };
}
