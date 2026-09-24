/** Only disposable fictional profiles and signing keys are permitted. */
export function prepareInterruptedMemoryFixture(options: {
  python: string;
  helperPath: string;
  request: Record<string, unknown> & { command: 'propose'; profileDirectory: string };
}): string;
