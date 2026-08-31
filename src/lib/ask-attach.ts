export const ASK_ATTACH_ACCEPT = "image/*,.pdf,.txt,.csv,.json,.md,application/pdf";
export const ASK_ATTACH_MAX_BYTES = 8 * 1024 * 1024;

const ALLOWED_EXT = /\.(pdf|png|jpe?g|gif|webp|txt|csv|json|md)$/i;

export function isAskAttachName(name: string): boolean {
  return ALLOWED_EXT.test(name.trim());
}

export function safeAskAttachName(name: string): string {
  const base = name.split(/[/\\]/).pop()?.trim() || "file";
  return base.replace(/[^\w.\- ()[\]]+/g, "_").slice(0, 80) || "file";
}

export async function fileToBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
