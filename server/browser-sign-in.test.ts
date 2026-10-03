import { describe, expect, it } from "vitest";
import {
  browserSignInRoute, knownSignInSites, onSignInSettled, openForSignIn, signInHandoverBlocks, signInHandovers, signInTarget, signedInAt,
  siteFromMap, startSignInBroker, WRONG_ACCOUNT, type SignInSite,
} from "./browser-sign-in.ts";

const portal = siteFromMap("fictional-portal", { origin: "https://app.fictional-portal.example", signIn: { host: "login.fictional-portal.example" }, scope: { urlParam: "acct" } })!;
const sites: SignInSite[] = [{ ...portal, name: "Fictional Portal" }];
/** A work browser whose sign-in tab moves through the given addresses, one per poll. */
function runtime(addresses: Array<string | null>) {
  const opened: string[] = []; let at = 0;
  return { opened, polls: () => at, runtime: {
    openSignInTab: async (url: string) => { opened.push(url); return "FICTIONALTARGET1"; },
    signInTabUrl: async () => addresses[Math.min(at++, addresses.length - 1)] ?? null,
  } };
}
const fast = { pollMs: 1, sites };
const until = async (test: () => boolean) => { for (let i = 0; i < 500 && !test(); i++) await new Promise(resolve => setTimeout(resolve, 2)); };

describe("open_for_sign_in address sources", () => {
  it("accepts a known site or an HTTPS address the person typed, and refuses page, tool and non-HTTPS addresses", () => {
    expect(signInTarget({ site: "Fictional Portal" }, sites, [])).toMatchObject({ url: "https://app.fictional-portal.example/" });
    expect(signInTarget({ site: "fictional-portal" }, sites, [])).toMatchObject({ site: { origin: portal.origin } });
    expect(signInTarget({ url: "https://app.fictional-portal.example/customers" }, sites, ["https://app.fictional-portal.example/customers"])).toMatchObject({ site: { name: "Fictional Portal" }, url: "https://app.fictional-portal.example/customers" });
    expect(signInTarget({ url: "https://strata.fictional.example/login" }, sites, ["see https://strata.fictional.example/login"].flatMap(text => text.match(/https:\S+/g) ?? []))).toMatchObject({ site: { origin: "https://strata.fictional.example" } });
    // Seen only on a page, in an email or a tool result: never in the person's own messages.
    expect(signInTarget({ url: "https://evil.fictional.example/login" }, sites, ["https://strata.fictional.example/login"])).toHaveProperty("error");
    expect(signInTarget({ url: "http://app.fictional-portal.example/" }, sites, ["http://app.fictional-portal.example/"])).toEqual({ error: "Bud opens only HTTPS sign-in pages." });
    expect(signInTarget({ url: "https://user:pw@app.fictional-portal.example/" }, sites, [])).toHaveProperty("error");
    expect(signInTarget({ site: "unknown-site" }, sites, [])).toHaveProperty("error");
  });
  it("never opens a path or query the person did not type, even on a known site", () => {
    // Injected page or bank text steering a known origin's path/query to carry data out.
    expect(signInTarget({ url: "https://app.fictional-portal.example/x?leak=fictional-balance-1234" }, sites, [])).toHaveProperty("error");
    expect(signInTarget({ url: "https://app.fictional-portal.example/customers?leak=1" }, sites, ["https://app.fictional-portal.example/customers"])).toHaveProperty("error");
    // A site name opens only its pinned login address; a conflicting url beside it is refused.
    expect(signInTarget({ site: "Fictional Portal", url: "https://app.fictional-portal.example/x?leak=1" }, sites, [])).toHaveProperty("error");
    expect(signInTarget({ site: "Fictional Portal", url: "https://app.fictional-portal.example/" }, sites, [])).toEqual({ site: sites[0], url: "https://app.fictional-portal.example/" });
    expect(signInTarget({ site: "https://app.fictional-portal.example/customers?leak=1" }, sites, [])).toEqual({ site: sites[0], url: "https://app.fictional-portal.example/" });
  });
  it("loads installed packs' site maps and the office's approved HTTPS sites", async () => {
    const known = await knownSignInSites(["https://approved.fictional.example", "http://plain.fictional.example"]);
    expect(known.find(site => site.key === "rei-cloud")).toMatchObject({ origin: "https://app.reimasterapps.com.au", signInHosts: ["reimasterapps.b2clogin.com"], accountParam: "reicid" });
    expect(known.map(site => site.origin)).toContain("https://approved.fictional.example");
    expect(known.map(site => site.origin)).not.toContain("http://plain.fictional.example");
  });
});

describe("sign-in handover", () => {
  it("detects the post-login address only once it is steady, off the sign-in host", async () => {
    expect(signedInAt(portal, "https://login.fictional-portal.example/b2c")).toBe(false);
    expect(signedInAt(portal, "https://app.fictional-portal.example/account/login")).toBe(false);
    expect(signedInAt(portal, "https://app.fictional-portal.example/customers/dashboard")).toBe(true);
    expect(signedInAt({ ...portal, postLogin: ["/customers/"] }, "https://app.fictional-portal.example/welcome")).toBe(false);
    const f = runtime(["https://app.fictional-portal.example/", "https://login.fictional-portal.example/b2c", "https://login.fictional-portal.example/b2c",
      "https://app.fictional-portal.example/customers/dashboard", "https://app.fictional-portal.example/customers/dashboard"]);
    const result = await openForSignIn({ site: "fictional-portal", reason: "Read arrears" }, { ...fast, runtime: f.runtime });
    expect(result).toEqual({ outcome: "signed_in", origin: portal.origin });
    expect(f.opened).toEqual(["https://app.fictional-portal.example/"]);
    expect(f.polls()).toBeGreaterThanOrEqual(5);
  });
  it("blocks actions on the site while the person signs in, and Done finishes it", async () => {
    const f = runtime(["https://login.fictional-portal.example/b2c"]);
    const pending = openForSignIn({ site: "fictional-portal", reason: "Read arrears", threadId: "thread-done" }, { ...fast, runtime: f.runtime });
    await until(() => signInHandovers("thread-done").length > 0);
    const [view] = signInHandovers("thread-done");
    expect(view).toMatchObject({ state: "waiting", message: "Sign in to Fictional Portal here. Bud carries on when you're signed in." });
    expect(signInHandoverBlocks("https://app.fictional-portal.example/customers")).toBe(true);
    expect(signInHandoverBlocks("https://login.fictional-portal.example/b2c")).toBe(true);
    expect(signInHandoverBlocks("https://other.fictional.example/")).toBe(false);
    expect(browserSignInRoute(`/api/browser/sign-in/${view.id}/done`, "POST", new URLSearchParams())).toEqual({ status: 200, body: { ok: true } });
    expect((await pending).outcome).toBe("signed_in");
    expect(signInHandoverBlocks("https://app.fictional-portal.example/customers")).toBe(false);
    expect(browserSignInRoute(`/api/browser/sign-in/${view.id}/done`, "POST", new URLSearchParams())?.status).toBe(409);
  });
  it("holds a different account until the person switches, even after Done", async () => {
    const addresses: string[] = ["https://app.fictional-portal.example/customers/dashboard?acct=other"];
    const f = { openSignInTab: async () => "FICTIONALTARGET2", signInTabUrl: async () => addresses[0] };
    const pending = openForSignIn({ site: "fictional-portal", reason: "Import", account: "mine", threadId: "thread-account" }, { ...fast, runtime: f });
    await until(() => signInHandovers("thread-account")[0]?.state === "wrong_account");
    const [view] = signInHandovers("thread-account");
    expect(view.message).toBe(WRONG_ACCOUNT);
    browserSignInRoute(`/api/browser/sign-in/${view.id}/done`, "POST", new URLSearchParams());
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(signInHandovers("thread-account")[0].state).toBe("wrong_account");
    addresses[0] = "https://app.fictional-portal.example/customers/dashboard?acct=mine";
    expect((await pending).outcome).toBe("signed_in");
  });
  it("reports a wrong account still showing when time runs out", async () => {
    const f = runtime(["https://app.fictional-portal.example/customers/dashboard?acct=other"]);
    expect((await openForSignIn({ site: "fictional-portal", reason: "Import", account: "mine" }, { ...fast, runtime: f.runtime, timeoutMs: 30 })).outcome).toBe("wrong_account");
  });
  it("times out after its limit with a clear message", async () => {
    const f = runtime(["https://login.fictional-portal.example/b2c"]);
    const result = await openForSignIn({ site: "fictional-portal", reason: "Read", threadId: "thread-timeout" }, { ...fast, runtime: f.runtime, timeoutMs: 30 });
    expect(result.outcome).toBe("timed_out");
    expect(signInHandovers("thread-timeout")[0].message).toMatch(/not finished within 15 minutes, so Bud paused/);
  });
  it("stops from the strip or the caller's signal at any point", async () => {
    const f = runtime(["https://login.fictional-portal.example/b2c"]);
    const pending = openForSignIn({ site: "fictional-portal", reason: "Read", threadId: "thread-stop" }, { ...fast, runtime: f.runtime });
    await until(() => signInHandovers("thread-stop").length > 0);
    browserSignInRoute(`/api/browser/sign-in/${signInHandovers("thread-stop")[0].id}/stop`, "POST", new URLSearchParams());
    expect((await pending).outcome).toBe("stopped");
    const controller = new AbortController();
    const aborted = openForSignIn({ site: "fictional-portal", reason: "Read", signal: controller.signal }, { ...fast, runtime: runtime(["https://login.fictional-portal.example/b2c"]).runtime });
    controller.abort();
    expect(await aborted).toEqual({ outcome: "stopped", origin: portal.origin });
  });
  it("Stop is final: a poll in flight when Stop lands never becomes signed in or a continue", async () => {
    let answer!: (url: string) => void; let polled!: () => void;
    const inFlight = new Promise<void>(done => { polled = done; });
    const slow = { openSignInTab: async () => "FICTIONALTARGET3", signInTabUrl: () => { polled(); return new Promise<string>(done => { answer = done; }); } };
    const events: string[] = [];
    const off = onSignInSettled(event => { if (event.threadId === "thread-race") events.push(event.outcome); });
    const pending = openForSignIn({ site: "fictional-portal", reason: "Read", threadId: "thread-race" }, { ...fast, runtime: slow });
    await inFlight;
    const id = signInHandovers("thread-race")[0].id;
    // Done first would normally sign in on the next answer; Stop must still win.
    browserSignInRoute(`/api/browser/sign-in/${id}/done`, "POST", new URLSearchParams());
    expect(browserSignInRoute(`/api/browser/sign-in/${id}/stop`, "POST", new URLSearchParams())?.status).toBe(200);
    answer("https://app.fictional-portal.example/customers/dashboard");
    expect((await pending).outcome).toBe("stopped");
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(events).toEqual(["stopped"]);
    expect(signInHandovers("thread-race")[0].state).toBe("stopped");
    expect(browserSignInRoute(`/api/browser/sign-in/${id}/done`, "POST", new URLSearchParams())?.status).toBe(409);
    off();
  });
  it("refuses an address the person did not give before opening anything", async () => {
    const f = runtime([]);
    await expect(openForSignIn({ site: "", url: "https://evil.fictional.example/", reason: "Read" }, { ...fast, runtime: f.runtime })).rejects.toThrow(/typed in this conversation/);
    expect(f.opened).toEqual([]);
  });
});

describe("Ask's open_for_sign_in tool", () => {
  const call = async (url: string, header: string, args: Record<string, unknown>) => {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: header },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "open_for_sign_in", arguments: args } }) });
    return (await response.json() as { result: { isError?: boolean; content: Array<{ text: string }> } }).result;
  };
  it("returns signed in within the same call, or a resumable wait the host continues", async () => {
    const f = runtime(["https://app.fictional-portal.example/customers/dashboard"]);
    const broker = await startSignInBroker({ threadId: "thread-tool", personUrls: () => [], approvedSites: () => [], isActive: () => true, ...fast, runtime: f.runtime, turnWaitMs: 5 });
    try {
      const signed = await call(broker.descriptor.url, broker.descriptor.headers[0].value, { site: "Fictional Portal", reason: "Read arrears" });
      expect(signed.isError).toBeUndefined();
      expect(signed.content[0].text).toMatch(/^Signed in to Fictional Portal/);
      expect((await call(broker.descriptor.url, broker.descriptor.headers[0].value, { url: "https://page-link.fictional.example/", reason: "Read" })).isError).toBe(true);

      const settled: Array<{ outcome: string; inTurn: boolean }> = [];
      const off = onSignInSettled(event => { if (event.threadId === "thread-wait") settled.push(event); });
      const slow = runtime(["https://login.fictional-portal.example/b2c"]);
      const waiting = await startSignInBroker({ threadId: "thread-wait", personUrls: () => [], approvedSites: () => [], isActive: () => true, ...fast, runtime: slow.runtime, turnWaitMs: 5 });
      const result = await call(waiting.descriptor.url, waiting.descriptor.headers[0].value, { site: "fictional-portal", reason: "Read" });
      expect(result.content[0].text).toMatch(/Still waiting .* RealBud continues this conversation/);
      // Still waiting after the call returned; Done finishes it and the host is told to continue.
      browserSignInRoute(`/api/browser/sign-in/${signInHandovers("thread-wait")[0].id}/done`, "POST", new URLSearchParams());
      await until(() => settled.length > 0);
      expect(settled).toEqual([expect.objectContaining({ outcome: "signed_in", inTurn: false })]);
      off(); waiting.close();
    } finally { broker.close(); }
  });
});
