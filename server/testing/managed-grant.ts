// Test-only: an active, fictional managed grant whose profile names the
// granted endpoint, so guarded worker launches receive the key.
import { applyManagedModelProfile } from "../hermes-pack.ts";
import { setWorkerModelAccessSnapshot } from "../hermes-runtime-env.ts";
import { setWorkerModelGrant } from "../worker-model-access.ts";
import type { ManagedModelChoiceId } from "../../shared/managed-model-choices.ts";

export const FICTIONAL_GATEWAY = "https://gateway.fictional.test/v1";
export const FICTIONAL_GRANTED_KEY = "fictional-granted-key";

export function grantManagedAccess(root: string, opts: { baseUrl?: string; choice?: ManagedModelChoiceId; key?: string } = {}): void {
  const baseUrl = opts.baseUrl ?? FICTIONAL_GATEWAY;
  applyManagedModelProfile(baseUrl, { root, choice: opts.choice ?? "flash-high" });
  setWorkerModelGrant({ state: "active", baseUrl, keyId: "fictional-key-id", spendCapLabel: "Fictional cap" });
  setWorkerModelAccessSnapshot({ REALBUD_MODEL_API_KEY: opts.key ?? FICTIONAL_GRANTED_KEY });
}

export function clearManagedAccess(): void {
  setWorkerModelGrant({ state: "none" });
  setWorkerModelAccessSnapshot({});
}
