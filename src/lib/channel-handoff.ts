import { api } from "@/state/store";
import { useCallback, useState } from "react";

export type HandoffMode = "result" | "summary";

/** Push an Ask reply or short summary to the paired phone channel. */
export async function sendChannelHandoff(opts: {
  mode: HandoffMode;
  messageId?: string;
}): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  try {
    const body = await api("/api/channels/handoff", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: opts.mode,
        ...(opts.messageId ? { messageId: opts.messageId } : {}),
      }),
    });
    if (!body || body.ok !== true) {
      return { ok: false, error: typeof body?.error === "string" ? body.error : "Couldn’t send to phone." };
    }
    return { ok: true, label: typeof body.label === "string" ? body.label : "phone" };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Couldn’t send to phone." };
  }
}

export function useChannelHandoff() {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const send = useCallback(async (opts: { mode: HandoffMode; messageId?: string }) => {
    setBusy(true);
    setNotice(null);
    const result = await sendChannelHandoff(opts);
    setBusy(false);
    setNotice(
      result.ok
        ? { ok: true, text: opts.mode === "summary" ? `Summary sent to ${result.label}` : `Sent to ${result.label}` }
        : { ok: false, text: result.error },
    );
    return result;
  }, []);
  return { busy, notice, setNotice, send };
}
