import { ensureSession } from "@/state/store";

export async function stageAskAttachment(file: File): Promise<{ path: string; name: string; size: number }> {
  const send = async () => {
    const token = await ensureSession().catch(() => "");
    const headers = new Headers();
    headers.set("content-type", "application/octet-stream");
    headers.set("x-realbud-filename", encodeURIComponent(file.name));
    if (token) headers.set("x-realbud-session", token);
    return fetch("/api/ask-attachments", { method: "POST", headers, body: file });
  };

  let res = await send();
  if (res.status === 401) {
    await ensureSession(true).catch(() => "");
    res = await send();
  }
  const body = await res.json().catch(() => ({})) as { error?: string; path?: string; name?: string; size?: number };
  if (!res.ok || !body.path || !body.name || typeof body.size !== "number") {
    throw new Error(body.error ?? "That file could not be attached.");
  }
  return { path: body.path, name: body.name, size: body.size };
}
