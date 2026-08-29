// Keeping secrets out of the native protocol log and stored bot text.
//
// The native tee writes every provider message verbatim, which is what makes
// protocol drift diagnosable — but session setup carries tokens. Stored bot
// replies, activity chip titles, and permission cards can too.
//
// The log keeps the SHAPE and loses the VALUES. Content redaction is
// high-precision on purpose: no generic hex/base64 heuristics.

/** Key names whose value is a credential. Matched case-insensitively as a
 * substring, so KEY catches ANTHROPIC_API_KEY and x-api-key. */
const SECRET_KEY_PARTS = ["token", "secret", "password", "passwd", "apikey", "api_key", "authorization", "auth_token"];

/** `key` alone is too broad — it matches `keyboard`, `keys`, `hotkey`. Only
 * treat it as a credential when it stands alone or is a suffix. */
function isSecretName(name: string): boolean {
  const lower = name.toLowerCase();
  if (SECRET_KEY_PARTS.some((part) => lower.includes(part))) return true;
  return /(^|[_.-])keys?$/.test(lower);
}

const mask = (value: string) => `«redacted ${value.length} chars»`;

const KEY_PREFIXES: RegExp[] = [
  /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bnpm_[A-Za-z0-9]{20,}/g,
  /\bntn_[A-Za-z0-9_-]{8,}/g,
  /\bsecret_[A-Za-z0-9]{20,}/g,
  /\bck_[A-Za-z0-9]{16,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
];
const BEARER = /(\bBearer\s+)([A-Za-z0-9._~+/=-]{12,})/g;
const PEM_BLOCK = /(-----BEGIN [A-Z ]*PRIVATE KEY-----)([\s\S]*?)(-----END [A-Z ]*PRIVATE KEY-----)/g;
const KEY_VALUE =
  /\b((?:[A-Za-z0-9_-]*_)?(?:api[_-]?key|apikey|secret|token|password|passwd|authorization|auth[_-]?token|access[_-]?key|private[_-]?key)s?)(["']?\s*[=:]\s*)(["']?)([A-Za-z0-9._~+/=-]{8,})\3/gi;

export function extractFirstSecret(text: string): string | null {
  if (!text || redactSecretsInText(text) === text) return null;
  for (const re of KEY_PREFIXES) {
    const match = new RegExp(re.source, re.flags).exec(text);
    if (match?.[0]) return match[0];
  }
  const bearer = new RegExp(BEARER.source, BEARER.flags).exec(text);
  if (bearer?.[2]) return bearer[2];
  const kv = new RegExp(KEY_VALUE.source, KEY_VALUE.flags).exec(text);
  if (kv?.[4]) return kv[4];
  return null;
}

export function stripSecretsForSpeech(text: string): string {
  return redactSecretsInText(text)
    .replace(/\s*«redacted \d+ chars»\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function hintToolFromSecret(secret: string): { slug: string; label: string } | null {
  if (/^ntn_/i.test(secret)) return { slug: "notion", label: "Notion" };
  if (/^xox[abposr]-/i.test(secret)) return { slug: "slack", label: "Slack" };
  if (/^(?:ghp|gho|ghu|ghs|ghr|github_pat)_/i.test(secret)) return { slug: "github", label: "GitHub" };
  return null;
}

export function redactSecretsInText(text: string): string {
  if (!text || text.length < 8) return text;
  let out = text;
  out = out.replace(PEM_BLOCK, (_m, open: string, body: string, close: string) => `${open}\n${mask(body.trim())}\n${close}`);
  for (const re of KEY_PREFIXES) out = out.replace(re, (m) => mask(m));
  out = out.replace(BEARER, (_m, lead: string, tok: string) => `${lead}${mask(tok)}`);
  out = out.replace(KEY_VALUE, (_m, key: string, sep: string, quote: string, value: string) => `${key}${sep}${quote}${mask(value)}${quote}`);
  return out;
}

/** Deep copy with credential VALUES replaced. Handles a plain object of env
 * vars and the ACP wire shape (env: [{name, value}]). */
export function redactSecrets(input: unknown, depth = 0): unknown {
  if (typeof input === "string") return redactSecretsInText(input);
  if (depth > 12 || input === null || typeof input !== "object") return input;

  if (Array.isArray(input)) {
    return input.map((item) => {
      if (
        item !== null &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        typeof (item as { name?: unknown }).name === "string" &&
        typeof (item as { value?: unknown }).value === "string"
      ) {
        const entry = item as { name: string; value: string };
        return isSecretName(entry.name) ? { ...entry, value: mask(entry.value) } : entry;
      }
      return redactSecrets(item, depth + 1);
    });
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "string" && isSecretName(key)) {
      out[key] = mask(value);
      continue;
    }
    out[key] = redactSecrets(value, depth + 1);
  }
  return out;
}
