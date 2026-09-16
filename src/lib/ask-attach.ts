export { ASK_ATTACH_ACCEPT, ASK_ATTACH_MAX_BYTES, isAskAttachName, safeAskAttachName } from "@shared/ask-attachments";

export async function fileToBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
