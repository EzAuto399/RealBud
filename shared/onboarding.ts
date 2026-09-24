export const ONBOARDING_STAGES = ['profile', 'office-rules', 'complete', 'recovery'] as const;
export type OnboardingStage = typeof ONBOARDING_STAGES[number];
export interface OnboardingState {
  version: 1;
  scope: string;
  revision: number;
  stage: OnboardingStage;
}

export function onboardingStage(value: unknown): value is OnboardingStage {
  return ONBOARDING_STAGES.some(stage => stage === value);
}

export function parseOnboardingState(value: unknown): OnboardingState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Your saved setup could not be checked. Try again.');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !== 'revision,scope,stage,version' || row.version !== 1 ||
      typeof row.scope !== 'string' || !/^[a-f0-9]{64}$/.test(row.scope) ||
      !Number.isSafeInteger(row.revision) || Number(row.revision) < 0 || !onboardingStage(row.stage)) {
    throw new Error('Your saved setup could not be checked. Try again.');
  }
  return row as unknown as OnboardingState;
}
