/** Client-side gate so Ask never sends a provider key to the worker.
 * Server `containsCredential` is the real refuse. Keep this tight. */
export function looksLikeProviderKey(text: string): boolean {
  if (!text || text.length < 8) return false;
  return (
    /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/.test(text) ||
    /\brbk_(?:live|test)_[A-Za-z0-9_-]{16,}/.test(text) ||
    /\bxai-[A-Za-z0-9_-]{16,}/.test(text) ||
    /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/.test(text) ||
    /\bgithub_pat_[A-Za-z0-9_]{20,}/.test(text) ||
    /api[_-]?key\s*[=:]\s*["']?[A-Za-z0-9._~+/=-]{12,}/i.test(text)
  );
}

export const KEY_ON_YOU =
  "Provider keys go on You → Attach model. Ask never sees the secret.";
