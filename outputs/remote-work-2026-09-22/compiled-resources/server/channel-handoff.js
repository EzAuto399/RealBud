export const HANDOFF_CLIP = 1400;
const SUMMARY_TURNS = 8;
function clip(text, openAskHint) {
    const body = text.trim();
    if (body.length <= HANDOFF_CLIP)
        return body;
    return `${body.slice(0, HANDOFF_CLIP)}…\n\n${openAskHint}`;
}
function textMessages(store) {
    const bot = store.productBud();
    if (!bot)
        return [];
    return store.activePath(bot.threadId).filter((m) => m.kind === "text" && Boolean(m.text?.trim()));
}
function stripChannelStamp(text) {
    return text.replace(/^\[(?:Telegram|Discord|Slack) · [^\]]+\]\s*/i, "").trim();
}
/** Deterministic Ask handoff copy for phone — no model call. */
export function buildHandoffPayload(store, opts) {
    const bot = store.productBud();
    if (!bot)
        return { ok: false, error: "Bud is not available yet. Open RealBud on your computer and finish Bud setup." };
    const messages = textMessages(store);
    if (opts.mode === "result") {
        let target;
        if (opts.messageId) {
            target = messages.find((m) => m.id === opts.messageId && m.role === "bot");
            if (!target)
                return { ok: false, error: "That reply is no longer in this conversation." };
        }
        else {
            target = [...messages].reverse().find((m) => m.role === "bot");
            if (!target)
                return { ok: false, error: "There is no saved reply in this conversation yet." };
        }
        const body = target.text.trim();
        const header = bot.busy
            ? "Bud is still working. Saved reply from Ask:"
            : "Reply from Ask:";
        return {
            ok: true,
            text: clip(`${header}\n\n${body}`, "Open Ask on desktop for the full reply."),
        };
    }
    const recent = messages.slice(-SUMMARY_TURNS);
    if (recent.length === 0) {
        return { ok: false, error: "There is nothing to summarise yet. Send a task here or in Ask on desktop." };
    }
    const lines = recent.map((m) => {
        const who = m.role === "user" ? "You" : "Bud";
        const body = stripChannelStamp(m.text).replace(/\s+/g, " ").trim();
        const short = body.length > 220 ? `${body.slice(0, 220)}…` : body;
        return `${who}: ${short}`;
    });
    return {
        ok: true,
        text: clip(`Ask handoff summary:\n\n${lines.join("\n")}`, "Open Ask on desktop for the full conversation."),
    };
}
export async function deliverToPairedPhone(text, channels) {
    for (const channel of channels) {
        if (!channel.pairedKey() || !channel.sendDigest)
            continue;
        try {
            await channel.sendDigest(text);
            return { ok: true, deliveredVia: channel.id, label: channel.label };
        }
        catch {
            return { ok: false, error: `Could not deliver to ${channel.label}. Keep your RealBud computer awake and try again.` };
        }
    }
    return { ok: false, error: "Pair Telegram, Discord or Slack first (You → Phone)." };
}
