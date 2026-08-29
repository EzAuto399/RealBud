/** Connection state is code-owned. Hermes never sees the key and must not narrate it. */

export type LinkedToolVoice = {
  label: string;
  connected: boolean;
  account?: string;
  lastPeekTitles?: string[];
};

const DENIES_LINKED_CONNECTION =
  /no connection is active|no connection is (?:linked|verified|present)|nothing is connected|not (?:currently )?connected to\b|nothing about your .{0,80} is verified in this session|not read in this build|cannot read pages|pages are not read/i;

function toolNamePattern(label: string): string {
  return label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function deniesLinkedConnection(text: string, tools: readonly LinkedToolVoice[] = []): boolean {
  if (DENIES_LINKED_CONNECTION.test(text)) return true;
  for (const tool of tools.filter((item) => item.connected)) {
    const name = toolNamePattern(tool.label);
    if (new RegExp(`${name} isn't a (?:named |RealBud )?office source`, "i").test(text)) return true;
    if (new RegExp(`no connection card for .{0,40}${name}`, "i").test(text)) return true;
  }
  return false;
}

export function askLayerVoice(action: { detail?: string }): string {
  const detail = action.detail?.replace(/\s+/g, " ").trim();
  return detail || "This key is on this device. Ask still cannot send.";
}

export function linkedToolsVoice(tools: readonly LinkedToolVoice[]): string {
  const ready = tools.filter((tool) => tool.connected).slice(0, 4);
  if (ready.length === 0) return "";
  const names = ready.map((tool) => {
    const account = tool.account?.trim();
    if (account && account !== "Key on this device") return `${account} (${tool.label})`;
    return tool.label;
  });
  const who = names.join(", ");
  const verb = ready.length === 1 ? "is" : "are";
  const titles = ready.flatMap((tool) => tool.lastPeekTitles ?? []).slice(0, 8);
  if (titles.length) {
    return `${who} ${verb} on this device. Visible now: ${titles.join("; ")}. Ask still cannot send.`;
  }
  return `${who} ${verb} on this device. Ask still cannot send.`;
}

export function reconcileAskWorkerText(text: string, tools: readonly LinkedToolVoice[]): string {
  const voice = linkedToolsVoice(tools);
  if (!voice || !deniesLinkedConnection(text, tools)) return text;
  return voice;
}
