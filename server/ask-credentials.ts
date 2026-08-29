import { matchAskConnectionSpeech, resolveConnectableTool, type AskOfficeTool } from "../shared/ask-connections.ts";
import { loadConfig, saveConfig, type ConfigIoOptions } from "./config.ts";
import { saveLinkedToolKey, type LinkedToolStatus } from "./linked-tools.ts";
import { extractFirstSecret, hintToolFromSecret, redactSecretsInText, stripSecretsForSpeech } from "./redact.ts";
import { verifyToolKey } from "./tool-verify.ts";

export type AdmitAskCredential =
  | { ok: true; text: string; linked?: LinkedToolStatus; composio?: boolean }
  | { ok: false; error: string; code: "CREDENTIAL_IN_ASK" | "TOOL_KEY_REJECTED" };

const REFUSAL = {
  ok: false as const,
  error: "Do not paste API keys or channel credentials into Ask. Open the connection card and use the write-only key field.",
  code: "CREDENTIAL_IN_ASK" as const,
};

function namedToolFromSpeech(spoken: string, secret: string): AskOfficeTool | null {
  const match = matchAskConnectionSpeech(spoken);
  if (match.kind === "option" && (match.option.id === "whatsapp-business" || match.option.id === "telegram")) {
    return null;
  }
  if (match.kind === "tool") return match.tool;
  if (match.kind === "option") {
    const fromOption = resolveConnectableTool(match.option.service);
    return fromOption?.kind === "app" ? fromOption : null;
  }
  const hinted = hintToolFromSecret(secret);
  if (!hinted) return null;
  const leftover = spoken.replace(/\b(?:con+e+c[a-z]{0,2}t|link|set\s*up|setup|me|to|with|bud)\b/gi, "").trim();
  if (leftover && leftover.toLowerCase() !== hinted.label.toLowerCase() && leftover.toLowerCase() !== hinted.slug) {
    return null;
  }
  return { id: hinted.slug, label: hinted.label, kind: "app", composioSlug: hinted.slug };
}

/** Persist a named-tool key from Ask after the provider accepts it. The raw secret never enters the transcript. */
export async function admitAskCredential(text: string, opts?: ConfigIoOptions): Promise<AdmitAskCredential> {
  if (redactSecretsInText(text) === text) return { ok: true, text };
  const secret = extractFirstSecret(text);
  if (!secret) return REFUSAL;
  const spoken = stripSecretsForSpeech(text);
  if (/^ck_/i.test(secret)) {
    saveConfig({ composio: { key: secret } }, opts);
    return { ok: true, text: redactSecretsInText(text), composio: true };
  }
  const tool = namedToolFromSpeech(spoken, secret);
  const slug = tool?.composioSlug;
  if (!tool || !slug) return REFUSAL;
  const checked = await verifyToolKey(slug, secret);
  if (!checked.ok) {
    return { ok: false, error: checked.error, code: "TOOL_KEY_REJECTED" };
  }
  const linked = saveLinkedToolKey({
    slug,
    label: tool.label,
    key: secret,
    account: checked.account,
  }, opts);
  return { ok: true, text: redactSecretsInText(text), linked };
}

export function reloadConfigAfterAdmit(opts?: ConfigIoOptions) {
  return loadConfig(opts);
}
