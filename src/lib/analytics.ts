// Analytics are off by default and must never receive addresses, contacts,
// balances, messages, portal URLs, or workflow content.

import { markOnboardingComplete, onboardingComplete } from "./onboarding";

export function initAnalytics() {
  /* off */
}

export function track(_event: string, _props?: Record<string, unknown>) {
  /* off */
}

export function identifyEmail(_email: string) {
  /* off */
}

export function emailGateDone(): boolean {
  return onboardingComplete();
}

export function setEmailGateDone(_status: "submitted" | "skipped") {
  markOnboardingComplete();
}
