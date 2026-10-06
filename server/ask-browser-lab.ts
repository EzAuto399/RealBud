// The browser runtime and portal-pack loader that Ask browser tasks use. In
// production that is always RealBud's work browser (browserRuntime) and the
// repo packs. Only the test lab can swap in the FICTIONAL REI portal
// (server/testing/w1-lab.ts), and only when this process was started with
// REALBUD_TEST_LAB=1 and REALBUD_TEST_W1_FICTIONAL_REI=1: without both, the
// swap throws and nothing changes.
import { browserRuntime } from "./browser-runtime.ts";
import type { BrowserSessionRuntime } from "./browser-session.ts";
import { loadPortalRecipePack, type PackLoader } from "./portal-recipe-task.ts";
import type { SignInRuntime } from "./browser-sign-in.ts";

let lab: { runtime: BrowserSessionRuntime & Pick<typeof browserRuntime, "status" | "connect">; load: PackLoader; signIn?: SignInRuntime } | null = null;
export const askBrowserLabEnabled = (env: NodeJS.ProcessEnv = process.env) => env.REALBUD_TEST_LAB === "1" && env.REALBUD_TEST_W1_FICTIONAL_REI === "1";
export function useAskBrowserLab(value: NonNullable<typeof lab>, env: NodeJS.ProcessEnv = process.env): void {
  if (!askBrowserLabEnabled(env)) throw new Error("The fictional browser lab is only available in a test lab process.");
  lab = value;
}
/** Ask's browser runtime: the work browser, unless the test lab swapped in its fictional portal. */
export const askBrowserRuntime = (): BrowserSessionRuntime & Pick<typeof browserRuntime, "status" | "connect"> => lab?.runtime ?? browserRuntime;
export const askPortalPackLoader = (): PackLoader => lab?.load ?? loadPortalRecipePack;
/** Opens the task's site and reads that tab's address for Start's sign-in wait: the runtime's own, or the lab portal's. */
export const askSignInRuntime = (runtime: object): Partial<SignInRuntime> => lab?.signIn ?? runtime;
