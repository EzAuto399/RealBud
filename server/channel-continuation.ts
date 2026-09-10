import type { Store } from "./store.ts";

/** Explicit paired-user commands; no worker call, permission or side effect. */
export function channelContinuation(text: string, store: Store): string | null {
  const command = text.trim().toLowerCase();
  if (!["/continue", "/status", "/help", "/start"].includes(command)) return null;
  if (command === "/help" || command === "/start") return "Same Bud, same conversation. Send a task here, then open Ask on your Mac to continue. /continue shows the latest saved reply; /status checks whether Bud is working. Your Mac and RealBud must stay awake and online. Files and full review controls remain on desktop.";
  const bot = store.productBud();
  if (!bot) return "Bud is not available yet. Open RealBud on your Mac and finish Bud setup.";
  if (command === "/status") return bot.busy ? "Bud is working. Open Ask on your Mac for progress, or use /continue to read the latest saved reply. A saved reply may belong to earlier work." : "Bud is available. Send your next task here or open Ask on your Mac. The conversation is shared.";
  const messages = store.activePath(bot.threadId);
  const last = [...messages].reverse().find(message => message.role === "bot" && message.kind === "text" && message.text?.trim());
  if (!last) return "There is no saved reply in this conversation yet. Send a task here or start one in Ask on your Mac.";
  const body = last.text!;
  const clipped = body.length > 1400;
  return `${bot.busy ? "Bud is still working. Previous saved reply:" : "Latest saved reply from Ask:"}\n\n${body.slice(0, 1400)}${clipped ? "…\n\nOpen Ask on your Mac for the full reply." : "\n\nContinue here with a follow-up, or open Ask on your Mac."}`;
}
