// Analytics are off by default and must never receive addresses, contacts,
// balances, messages, portal URLs, or workflow content.

export function track(_event: string, _props?: Record<string, unknown>) {
  /* off */
}

export function identifyEmail(_email: string) {
  /* off */
}

export function setEmailGateDone(_status: "submitted" | "skipped") {
  /* off */
}
