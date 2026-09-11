import { buildHandoffPayload } from "./channel-handoff.ts";
import type { Store } from "./store.ts";

const HELP =
  "Same Bud, same conversation on phone and desktop. Send a task here or in Ask on your Mac — replies stay on this thread. /continue shows the latest saved reply; /summary sends a short handoff of recent turns; /status checks whether Bud is working. On desktop, use Send to phone to push a reply or summary here. Your Mac and RealBud must stay awake and online. Files and full review controls remain on desktop.";

/** Explicit paired-phone commands; no worker call, permission or side effect. */
export function channelContinuation(text: string, store: Store): string | null {
  const command = text.trim().toLowerCase();
  if (!["/continue", "/summary", "/status", "/help", "/start"].includes(command)) return null;
  if (command === "/help" || command === "/start") return HELP;
  const bot = store.productBud();
  if (!bot) return "Bud is not available yet. Open RealBud on your Mac and finish Bud setup.";
  if (command === "/status") {
    return bot.busy
      ? "Bud is working. Open Ask on your Mac for progress, or use /continue for the latest saved reply. A saved reply may belong to earlier work."
      : "Bud is available. Send your next task here or open Ask on your Mac. The conversation is shared.";
  }
  if (command === "/summary") {
    const built = buildHandoffPayload(store, { mode: "summary" });
    return built.ok ? built.text : built.error;
  }
  const built = buildHandoffPayload(store, { mode: "result" });
  if (!built.ok) return built.error;
  // Keep /continue wording close to the prior UX while sharing the clip builder.
  return built.text.replace(/^Reply from Ask:/, "Latest saved reply from Ask:").replace(
    /^Bud is still working\. Saved reply from Ask:/,
    "Bud is still working. Previous saved reply:",
  );
}
