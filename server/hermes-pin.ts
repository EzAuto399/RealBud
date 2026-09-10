// Hermes is a pinned worker, not a floating latest and not our product name.
// Bump this object when we choose to take an upstream release. Do not track main.
export const HERMES_PIN = {
  product: "0.20.3",
  tag: "v2026.8.16.2",
  commit: "7339f5f160db5c96657a3bab60151227cc61f66c",
  released: "2026-08-17",
  repo: "https://github.com/NousResearch/hermes-agent",
  /** Isolated from the user's personal Hermes profile. */
  profile: "property",
} as const;

/** All RealBud entry points resolve the same independently installed CLI. */
export function hermesCli(): string {
  return process.env.REALBUD_HERMES_CLI?.trim() || "hermes";
}

export function hermesInstallCommand(platform: NodeJS.Platform): string | null {
  if (platform === "win32") return null;
  return (
    `curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash -s -- ` +
    `--commit ${HERMES_PIN.commit} --force-commit`
  );
}

/** `hermes --version` prints e.g. "Hermes Agent v0.20.3 (2026.8.16.2)". */
export function parseHermesVersion(text: string): { product?: string; calendar?: string } {
  const product = text.match(/\bv(\d+\.\d+\.\d+)\b/)?.[1];
  const calendar = text.match(/\((\d{4}\.\d{1,2}\.\d{1,2}(?:\.\d+)?)\)/)?.[1];
  return { product, calendar };
}

export function hermesMatchesPin(versionText: string): boolean {
  const parsed = parseHermesVersion(versionText);
  return parsed.product === HERMES_PIN.product && parsed.calendar === HERMES_PIN.tag.slice(1);
}

// Hermes remains independently installed. This is an explicit adapter support
// list, not permission to float to arbitrary future releases. The install pin
// above remains the rollback build; support does not rewrite the user's CLI.
export const HERMES_COMPATIBLE_RELEASES = [
  { product: HERMES_PIN.product, calendar: HERMES_PIN.tag.slice(1) },
  { product: "0.21.0", calendar: "2026.8.31" },
] as const;

export function hermesIsCompatible(versionText: string): boolean {
  const parsed = parseHermesVersion(versionText);
  return HERMES_COMPATIBLE_RELEASES.some((release) =>
    release.product === parsed.product && release.calendar === parsed.calendar,
  );
}
