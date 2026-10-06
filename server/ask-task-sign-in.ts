// Start of an Ask browser task on a mapped portal (an installed pack's map
// names its sign-in host, e.g. REI Cloud): RealBud opens the task's site in the
// work browser and, through the ordinary sign-in handover (browser-sign-in.ts),
// watches that tab's address alone until the person has signed in. Bud's turn
// starts only then, so nobody picks a page or types labels, and the broker
// takes no action on the site meanwhile. A site without a map, or a runtime
// that cannot open a tab, keeps the earlier open-and-start (null here).
import { openForSignIn, signInHandovers, siteFromMap, type SignInOutcome, type SignInRuntime, type SignInSite } from "./browser-sign-in.ts";
import { portalMapForSites, type PackLoader } from "./portal-recipe-task.ts";

const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms).unref?.(); });

export async function askTaskSignIn(input: {
  threadId: string; sites: readonly string[]; runtime: Partial<SignInRuntime>; load: PackLoader; signal: AbortSignal; pollMs?: number;
}): Promise<{ site: SignInSite; outcome: Promise<SignInOutcome> } | null> {
  const { openSignInTab, signInTabUrl } = input.runtime;
  if (!openSignInTab || !signInTabUrl) return null;
  const map = await portalMapForSites(input.sites, input.load).catch(() => null);
  const site = map ? siteFromMap(map.portal, { origin: map.pack.origin, signIn: { hosts: map.pack.signIn.hosts }, scope: { urlParam: map.pack.account.urlParam } }) : null;
  if (!site?.signInHosts.length) return null;
  const runtime: SignInRuntime = { openSignInTab: url => openSignInTab.call(input.runtime, url), signInTabUrl: id => signInTabUrl.call(input.runtime, id) };
  const outcome = openForSignIn({ site: site.key, reason: `Sign in to ${site.name} so Bud can do this task.`, threadId: input.threadId, signal: input.signal },
    { runtime, sites: [site], ...(input.pollMs ? { pollMs: input.pollMs } : {}) }).then(result => result.outcome);
  // Answer once the handover shows (its tab is open), bounded, so the sign-in strip is there when Start returns.
  let ended = false;
  void outcome.then(() => { ended = true; }, () => { ended = true; });
  for (let i = 0; i < 100 && !ended && !signInHandovers(input.threadId).some(item => item.origin === site.origin); i++) await sleep(100);
  return { site, outcome };
}
