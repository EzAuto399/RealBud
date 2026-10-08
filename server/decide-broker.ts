// Bud's `decide` tool: typed questions to Jev mid-turn (classify, pick among
// options, score). Mounted per ACP session as a loopback MCP server, only for a
// person's own attended Ask while Jev is ready. Answers are suggestions, never
// an approval. Bud chooses the state it sends; credential-shaped state is
// refused, never redacted. Nothing here logs or records the state or answers.
import { containsCredential } from "./redact.ts";
import { startLoopbackToolServer, toolError, type LoopbackToolResult, type LoopbackToolServer } from "./web-research-broker.ts";

export const DECIDE_SERVER = "decisions";
export const MAX_DECISIONS_PER_TURN = 10;
export const SUGGESTION_ONLY = "Suggestion only — not an approval; confirm with the person before acting.";

// Structurally jev-client's types, not imported: contracts.ts names this file,
// and the renderer typecheck must not pull jev-client.ts in through it.
type JevFailure = "refused" | "budget" | "unavailable" | "timeout" | "http" | "invalid" | "aborted";
type JevRequest = { state: unknown; questions: Record<string, unknown> };
type JevResult = { ok: true; answers: Record<string, unknown> } | { ok: false; reason: JevFailure };
type JevCall = { ok: boolean; id?: string; model?: string; ms?: number; usage?: { input_tokens: number; output_tokens: number } };

/** The host's binding for one turn. */
export interface BudDecisions {
  /** False once the RealBud member is not the one this turn was bound for. */
  sameMember(): boolean;
  /** `jevReady()` now. */
  ready(): boolean;
  /** `decide` from jev-client (refuses on grant, key and entitlement). */
  decide(request: JevRequest, options: { signal?: AbortSignal }): Promise<JevResult>;
}
export interface DecideReceipt { tool: "decide"; outcome: "succeeded" | "failed" | "refused"; questions?: number }

const CRITERION = { type: "string", minLength: 1, maxLength: 4000 };
const TOOLS = [{
  name: "decide",
  description: "Ask a fast, cheap typed-decision model up to 8 questions about a state you choose: classify (choice), yes/no (noul, answered as P(yes)) or score along an ordered scale (score, answered as an index). Use it to classify an item, pick among known options or rank, when that is quicker than reasoning it out. Send only the facts the question needs. Never send passwords, codes, cookies, session or token values, or any other secret: such state is refused. Answers are suggestions only: never an approval, and never a reason to act without the person confirming.",
  inputSchema: { type: "object", additionalProperties: false, required: ["state", "questions"], properties: {
    state: { description: "What the questions are about: a non-empty string, object or array, at most 16 KiB as JSON." },
    questions: { type: "object", minProperties: 1, maxProperties: 8, description: "Question keys (letters, digits, _.:-, up to 64) to questions.",
      propertyNames: { pattern: "^[A-Za-z0-9_.:-]{1,64}$" },
      additionalProperties: { oneOf: [
        { type: "object", additionalProperties: false, required: ["type", "instructions", "criteria"], properties: {
          type: { const: "choice" }, instructions: { type: "string", minLength: 1, maxLength: 8000 },
          criteria: { type: "object", minProperties: 2, maxProperties: 64, description: "Option key to what it means.", additionalProperties: CRITERION } } },
        { type: "object", additionalProperties: false, required: ["type", "instructions"], properties: {
          type: { const: "noul" }, instructions: { type: "string", minLength: 1, maxLength: 8000 },
          criteria: { type: "object", additionalProperties: false, required: ["true", "false"], properties: { true: CRITERION, false: CRITERION } } } },
        { type: "object", additionalProperties: false, required: ["type", "instructions", "criteria"], properties: {
          type: { const: "score" }, instructions: { type: "string", minLength: 1, maxLength: 8000 },
          criteria: { type: "array", minItems: 1, maxItems: 64, description: "Ordered scale; the answer is a float index into it.", items: CRITERION } } },
      ] } },
  } },
}];

const SECRET_TOKENS = new Set(["pass", "password", "passwords", "passwd", "passcode", "pwd", "pin", "otp", "mfa", "totp", "cookie", "cookies",
  "session", "sessionid", "token", "tokens", "secret", "secrets", "auth", "authorization", "bearer", "credential", "credentials", "apikey", "privatekey"]);
const CODE_CONTEXT = new Set(["verification", "auth", "otp", "sms", "login", "security"]);
/** A one-time code in text: "Your code is 482913", "OTP: 1234". A bare
 * "Property code: 4021" is not one. */
const CODE_VALUE = /\b(?:otp|passcode|one[- ]time (?:pass)?code|(?:verification|security|sign[- ]in|login|access|auth(?:entication)?|confirmation) code|your code|code is)\b\D{0,20}\d{4,8}\b/i;
/** True when a key names a secret: after NFKC, split on camelCase, snake, kebab
 * and digit boundaries, any WHOLE token is a secret word (so possessionDate,
 * footprint and postcode pass). A key mixing Latin with Cyrillic or Greek
 * letters (a confusable "pаssword") is refused outright. */
export function secretKeyName(key: string): boolean {
  const normal = key.normalize("NFKC");
  if (/\p{Script=Latin}/u.test(normal) && /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(normal)) return true;
  const tokens = normal.replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2").replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
    .replace(/(\p{L})(\p{N})/gu, "$1 $2").replace(/(\p{N})(\p{L})/gu, "$1 $2")
    .toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return tokens.some((token, index) => SECRET_TOKENS.has(token) || token === "api" && tokens[index + 1] === "key" || token === "private" && tokens[index + 1] === "key")
    || tokens.includes("code") && (tokens.length === 1 || tokens.some(token => CODE_CONTEXT.has(token)));
}
/** True when any string anywhere in `value` carries a one-time code, any key
 * names a secret (when `keys`), or it nests too deep to check. */
function secretIn(value: unknown, keys: boolean, depth = 0): boolean {
  if (depth > 64) return true;
  if (typeof value === "string") return CODE_VALUE.test(value.normalize("NFKC"));
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(item => secretIn(item, keys, depth + 1));
  return Object.entries(value).some(([key, item]) => (keys && secretKeyName(key)) || secretIn(item, keys, depth + 1));
}

const FAILURE: Record<JevFailure, string> = {
  refused: "Typed decisions are not available for this office right now. Carry on without them.",
  budget: "The office's AI budget is used up, so no decision was made. Carry on without it.",
  unavailable: "Typed decisions could not be reached. Carry on without them.",
  timeout: "Typed decisions took too long and stopped. Carry on without them.",
  http: "Typed decisions could not be reached. Carry on without them.",
  invalid: "The decision request was not accepted: use 1 to 8 questions with keys of letters, digits and _.:- (at most 64), non-empty instructions, 2 to 64 choice options, 1 to 64 score steps, noul criteria with only true and false, and state of at most 16 KiB. Nothing was decided.",
  aborted: "Bud stopped this decision. Nothing was decided.",
};

export async function startDecideBroker(options: {
  /** The current turn's id while it may still act, else null. */
  turnId(): string | null;
  /** The current turn's binding, else undefined. */
  decisions(): BudDecisions | undefined;
  receipt?: (receipt: DecideReceipt) => void;
  /** Each answered call, for the turn's run cost (`recordJevUsage`): its id,
   * model, tokens and milliseconds are read there, never the state or answers. */
  record?: (result: JevCall) => void;
}): Promise<LoopbackToolServer> {
  const note = (receipt: DecideReceipt) => { try { options.receipt?.(receipt); } catch { /* receipts never change the outcome */ } };
  let spent = { turn: "", calls: 0 };
  return startLoopbackToolServer({
    name: DECIDE_SERVER,
    serverName: "Bud decisions",
    tools: TOOLS,
    maxConcurrent: 2,
    isActive: () => options.turnId() !== null && options.decisions() !== undefined,
    async call(_name, args, signal): Promise<LoopbackToolResult> {
      const turn = options.turnId(), binding = options.decisions();
      if (!turn || !binding) return toolError("Bud is no longer working on this request.");
      const refuse = (text: string) => { note({ tool: "decide", outcome: "refused" }); return toolError(text); };
      if (!binding.sameMember()) return refuse("The RealBud member changed, so no decision was asked.");
      if (!binding.ready()) return refuse(FAILURE.refused);
      const { state, questions } = args;
      if (Object.keys(args).some(key => key !== "state" && key !== "questions") || !questions || typeof questions !== "object" || Array.isArray(questions)) {
        return refuse("decide takes state and questions (an object of question keys to questions).");
      }
      if (containsCredential(JSON.stringify(args)) || secretIn(state, true) || secretIn(questions, false)) {
        return refuse("This state looks like it carries a credential, cookie, session or token. Remove those fields and values and ask again. Nothing was sent.");
      }
      // Spend bound: counted before the call, since a timed-out call may still be charged.
      if (spent.turn !== turn) spent = { turn, calls: 0 };
      if (spent.calls >= MAX_DECISIONS_PER_TURN) return refuse(`Bud has asked ${MAX_DECISIONS_PER_TURN} decisions in this request, the most allowed. Carry on without more.`);
      spent.calls += 1;
      const count = Object.keys(questions).length;
      const result = await binding.decide({ state, questions: questions as JevRequest["questions"] }, { signal });
      try { options.record?.(result); } catch { /* counting never changes the outcome */ }
      if (!result.ok) { note({ tool: "decide", outcome: "failed", questions: count }); return toolError(FAILURE[result.reason]); }
      note({ tool: "decide", outcome: "succeeded", questions: count });
      return { content: [{ type: "text", text: `${JSON.stringify({ answers: result.answers })}\n${SUGGESTION_ONLY}` }] };
    },
  });
}
