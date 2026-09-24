import type { BankDownloadArtifact, BankSourceUpload } from "../../shared/bank-source";

function base64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let index = 0; index < bytes.length; index += 32_768) parts.push(String.fromCharCode(...bytes.subarray(index, index + 32_768)));
  return btoa(parts.join(""));
}

export async function readBankFile(file: Pick<File, "name" | "size" | "arrayBuffer">): Promise<BankSourceUpload> {
  if (!file.size || file.size > 750_000) throw new Error("Choose a non-empty CSV smaller than 750 KB.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length !== file.size) throw new Error("The file changed while being read. Choose the original CSV again.");
  try {
    const csv = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (csv.includes("\0")) throw new Error("NUL byte");
  } catch { throw new Error("This file is not a supported UTF-8 CSV. Export a UTF-8 copy from the bank. Your source file has not been changed."); }
  return { filename: file.name, bytesBase64: base64(bytes) };
}

export async function bankDownloadBytes(artifact: BankDownloadArtifact): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof artifact.bytesBase64 !== "string" || artifact.bytesBase64.length > 1_000_000 || !/^[a-f0-9]{64}$/.test(artifact.digest)) throw new Error("The download failed its file integrity check. Reload the saved review.");
  let bytes: Uint8Array<ArrayBuffer>;
  try { bytes = Uint8Array.from(atob(artifact.bytesBase64), character => character.charCodeAt(0)); }
  catch { throw new Error("The download failed its file integrity check. Reload the saved review."); }
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
  if (bytes.length !== artifact.byteLength || base64(bytes) !== artifact.bytesBase64 || digest !== artifact.digest) throw new Error("The download failed its file integrity check. Reload the saved review.");
  return bytes;
}
