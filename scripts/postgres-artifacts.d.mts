// Types for scripts/postgres-artifacts.mjs.
export interface PostgresArtifact {
  file: string;
  url: string;
  sha256: string;
  bytes: number;
  architectures: readonly string[];
}

export const POSTGRES_MAJOR: number;
export const POSTGRES_ARTIFACTS: Record<string, PostgresArtifact>;
export const RUNTIME_TOP_LEVEL: readonly string[];
export const LICENCE_NAMES: readonly string[];

export function artifactKey(platform: string, arch: string): string;
export function artifactFor(platform: string, arch: string): PostgresArtifact | null;
export function isRuntimeEntry(entryPath: string): boolean;
export function isExcludedFromRuntime(entryPath: string): boolean;
export function shouldExtract(entryPath: string): boolean;
export function findLicenceEntry(entries: readonly string[]): string | null;
export function requiredExecutables(platform: string): string[];
