import { describe, expect, it } from "vitest";
import { askTaskSignIn } from "./ask-task-sign-in.ts";
import { signInHandovers } from "./browser-sign-in.ts";
import { FICTIONAL_REI_ORIGIN, FICTIONAL_REI_SIGNIN, fictionalReiPack } from "./testing/fictional-rei-portal.ts";

const load = async () => fictionalReiPack();
/** The work browser's tab for the task: its address only, as the person moves through sign-in. */
const tab = (start: string) => {
  const state = { url: start, opened: [] as string[] };
  return { state, runtime: { openSignInTab: async (url: string) => { state.opened.push(url); return "fictional-tab"; }, signInTabUrl: async () => state.url } };
};

describe("Start's sign-in wait for an Ask task on a mapped portal", () => {
  it("opens the portal, shows the handover at once, and settles signed in only once the tab is back on the portal", async () => {
    const { state, runtime } = tab(`${FICTIONAL_REI_SIGNIN}/b2c_1_signin/authorize`);
    const signal = new AbortController().signal;
    const wait = await askTaskSignIn({ threadId: "fictional-thread-1", sites: ["rei-mock.fictional.test"], runtime, load, signal, pollMs: 10 });
    expect(wait?.site).toMatchObject({ key: "rei-cloud", name: "REI Cloud", origin: FICTIONAL_REI_ORIGIN });
    expect(state.opened).toEqual([`${FICTIONAL_REI_ORIGIN}/`]);
    expect(signInHandovers("fictional-thread-1")).toEqual([expect.objectContaining({ state: "waiting", message: "Sign in to REI Cloud here. Bud carries on when you're signed in." })]);
    let settled: string | null = null;
    void wait!.outcome.then(outcome => { settled = outcome; });
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(settled).toBeNull(); // still on the sign-in host
    state.url = `${FICTIONAL_REI_ORIGIN}/customers/dashboard`;
    expect(await wait!.outcome).toBe("signed_in");
  });

  it("ends as stopped when the task ends during the wait", async () => {
    const { runtime } = tab(`${FICTIONAL_REI_SIGNIN}/b2c_1_signin/authorize`);
    const stop = new AbortController();
    const wait = await askTaskSignIn({ threadId: "fictional-thread-2", sites: [FICTIONAL_REI_ORIGIN], runtime, load, signal: stop.signal, pollMs: 10 });
    stop.abort();
    expect(await wait!.outcome).toBe("stopped");
  });

  it("keeps the earlier open-and-start for a site without a map or a runtime that cannot open a tab", async () => {
    const signal = new AbortController().signal;
    expect(await askTaskSignIn({ threadId: "fictional-thread-3", sites: ["portal.fictional-strata.example"], runtime: tab("about:blank").runtime, load, signal })).toBeNull();
    expect(await askTaskSignIn({ threadId: "fictional-thread-3", sites: [FICTIONAL_REI_ORIGIN], runtime: {}, load, signal })).toBeNull();
    expect(await askTaskSignIn({ threadId: "fictional-thread-3", sites: [FICTIONAL_REI_ORIGIN], runtime: tab("about:blank").runtime, load: async () => { throw new Error("no pack"); }, signal })).toBeNull();
    expect(signInHandovers("fictional-thread-3")).toEqual([]);
  });
});
