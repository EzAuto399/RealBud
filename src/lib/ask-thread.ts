import { isSpentConnectReceipt } from "@shared/ask-actions";

import type { Message } from "@/state/store";

export type AskThreadItem =
  | { kind: "message"; message: Message; newDay: boolean }
  | { kind: "spent-group"; messages: Message[]; newDay: boolean };

function isSpentConnectMessage(message: Message): boolean {
  return message.kind === "action" && isSpentConnectReceipt(message.action);
}

function isLayerConnectVoice(message: Message): boolean {
  return message.role === "bot"
    && message.kind === "text"
    && /(?:on this device|accepted this key|not read in this build)/i.test(message.text ?? "");
}

function isLaterAsk(message: Message): boolean {
  if (isSpentConnectMessage(message) || message.kind === "activity" || isLayerConnectVoice(message)) return false;
  return true;
}

function isNewDay(previousAt: number | undefined, at: number): boolean {
  if (previousAt == null) return true;
  return new Date(previousAt).toDateString() !== new Date(at).toDateString();
}

/** Older spent connect receipts collapse so the thread is the last ask, not a setup log. */
export function foldAskSpentConnects(messages: readonly Message[]): AskThreadItem[] {
  const spentAt = messages.flatMap((message, index) => (isSpentConnectMessage(message) ? [index] : []));
  const lastSpent = spentAt[spentAt.length - 1];
  const laterAsk = lastSpent != null && messages.slice(lastSpent + 1).some(isLaterAsk);
  const foldFrom = laterAsk ? spentAt : spentAt.slice(0, -1);
  const foldSet = foldFrom.length >= 2 ? new Set(foldFrom) : new Set<number>();
  const folded = foldFrom.length >= 2 ? foldFrom.map((index) => messages[index]!) : [];

  const items: AskThreadItem[] = [];
  let placed = false;
  let previousAt: number | undefined;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (foldSet.has(index)) {
      if (!placed) {
        items.push({ kind: "spent-group", messages: folded, newDay: isNewDay(previousAt, message.at) });
        previousAt = message.at;
        placed = true;
      }
      continue;
    }
    items.push({ kind: "message", message, newDay: isNewDay(previousAt, message.at) });
    previousAt = message.at;
  }
  return items;
}
