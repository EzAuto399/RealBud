/** Transport only. Successful decoding does not validate a business graph or
 * authorize preview, staging, restore, or access to any filesystem path. */
export const PRIVATE_BACKUP_V2_VERSION = 2 as const;
export const PRIVATE_BACKUP_V2_HEADER_BYTES = 64;
export const PRIVATE_BACKUP_V2_FRAME_HEADER_BYTES = 16;
export const PRIVATE_BACKUP_V2_TAG_BYTES = 16;
export const PRIVATE_BACKUP_V2_LIMITS = Object.freeze({
  archiveBytes: 1024 * 1024 * 1024,
  entryBytes: 16 * 1024 * 1024,
  entryCount: 100_000,
  frameBytes: 1024 * 1024,
  nameBytes: 1024,
});
export type PrivateBackupCodecLimits = { -readonly [K in keyof typeof PRIVATE_BACKUP_V2_LIMITS]: number };
export interface PrivateBackupCodecEntry {
  /** Opaque encrypted name. The catalog must separately validate its meaning. */
  name: string;
  size: number;
  data: AsyncIterable<Uint8Array>;
}
export interface PrivateBackupCodecEntryMetadata { index: number; name: string; size: number }
export interface PrivateBackupCodecEntryEnd extends PrivateBackupCodecEntryMetadata { digest: string }
export interface PrivateBackupCodecReceipt {
  version: 2;
  archiveId: string;
  archiveBytes: number;
  archiveDigest: string;
  entryCount: number;
  contentBytes: number;
  frameCount: number;
  manifestDigest: string;
  contentDigest: string;
}
export interface PrivateBackupCodecOptions {
  passphrase: string;
  signal?: AbortSignal;
  /** An operation may lower admission limits, never exceed supported limits. */
  limits?: Partial<PrivateBackupCodecLimits>;
}
export interface PrivateBackupCodecEncodeOptions extends PrivateBackupCodecOptions {
  /** Invoked only after the consumer requests completion of the entire stream. */
  onComplete?: (receipt: PrivateBackupCodecReceipt) => void | Promise<void>;
}
export interface PrivateBackupCodecVisitor {
  /** All visitor output remains provisional until decode resolves after EOF.
   * A caller must quarantine it and then validate the complete business graph. */
  begin(entry: PrivateBackupCodecEntryMetadata): void | Promise<void>;
  data(chunk: Uint8Array): void | Promise<void>;
  end(entry: PrivateBackupCodecEntryEnd): void | Promise<void>;
}
export interface PrivateBackupCodecDecodeOptions extends PrivateBackupCodecOptions {
  visitor: PrivateBackupCodecVisitor;
}
