// Types for scripts/postgres-relocatable.mjs. Kept beside the implementation so
// the server typecheck can validate both the module's own callers and its tests.
export const REQUIRED_RUNTIME_DIRECTORIES: readonly string[];

export interface RelocatabilityReport {
  relocatable: boolean;
  /** Dependencies outside the runtime and outside the operating system. */
  external: string[];
  /** Expected sibling directories that are absent or not directories. */
  missing: string[];
}

export function parseOtoolDependencies(stdout: string): string[];

export function classifyDependency(dependency: string, runtimeRoot: string): 'internal' | 'system' | 'external';

export function assessRelocatability(
  runtimeRoot: string,
  executablePaths: readonly string[],
  options?: { platform?: NodeJS.Platform; inspect?: (binary: string) => Promise<string> },
): Promise<RelocatabilityReport>;

export function relocatabilityProblem(report: RelocatabilityReport): string | null;
