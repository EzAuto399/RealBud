import { api } from "@/state/store";
import { ASK_ATTACH_MAX_BYTES, fileToBase64, isAskAttachName } from "./ask-attach";
import { fileAttachment, type FileAttachment } from "./composer-attachments";

export async function persistAskFile(file: Pick<File, "name" | "size"> & Blob): Promise<FileAttachment | null> {
  if (!isAskAttachName(file.name)) return null;
  if (file.size > ASK_ATTACH_MAX_BYTES) {
    throw new Error("that file is too large (8 MB)");
  }
  const saved = await api("/api/ask/attachments", {
    method: "POST",
    body: JSON.stringify({
      name: file.name,
      size: file.size,
      contentBase64: await fileToBase64(file),
    }),
  });
  if (!saved?.path || !saved?.name) return null;
  return fileAttachment(String(saved.name), String(saved.path), Number(saved.size) || file.size);
}

export async function persistAskFiles(files: readonly File[]): Promise<{
  attachments: FileAttachment[];
  rejectedNames: string[];
}> {
  const attachments: FileAttachment[] = [];
  const rejectedNames: string[] = [];
  for (const file of files) {
    try {
      const saved = await persistAskFile(file);
      if (saved) attachments.push(saved);
      else rejectedNames.push(file.name);
    } catch {
      rejectedNames.push(file.name);
    }
  }
  return { attachments, rejectedNames };
}
