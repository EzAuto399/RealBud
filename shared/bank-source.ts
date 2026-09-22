export interface BankSourceUpload { filename: string; bytesBase64: string }
export interface BankSourceArtifact extends BankSourceUpload {
  encoding: "utf-8" | "utf-8-bom";
  byteLength: number;
  digest: string;
}
export interface BankDownloadArtifact extends BankSourceArtifact {
  csv: string;
  originalBytesCaptured: boolean;
}
