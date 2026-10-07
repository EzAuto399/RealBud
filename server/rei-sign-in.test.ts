import { describe, expect, it, vi } from "vitest";
import { browserSignInRoute, noteSiteSignIn, openForSignIn, siteFromMap, siteSignInState, signInHandovers, type SignInSite } from "./browser-sign-in.ts";
import { REI_SIGN_IN_MISSED } from "./rei-morning-refresh.ts";
import { noteReiRefresh, REI_DESK_THREAD, REI_SIGNED_IN_FRESH_MS, REI_SITE, reiLoopsToResume, reiSignInView, resumeReiWhenFree, startReiSignIn } from "./rei-sign-in.ts";
import type { LoopRun } from "../shared/contracts.ts";

const rei: SignInSite = siteFromMap("rei-cloud", { origin: "https://rei.fictional.test", signIn: { host: "signin.rei.fictional.test" } })!;
const NOW = 1_800_000_000_000;
const run = (loopId: string, status: LoopRun["status"], detail: string, at = NOW - 60_000): LoopRun =>
  ({ id: `${loopId}-${at}`, loopId: loopId as LoopRun["loopId"], loopName: { "bank-references": "Bank reference review", "rei-morning-refresh": "REI morning refresh", "weekly-bills": "Weekly bills review" }[loopId] ?? loopId,
    scheduledFor: at, status, manual: false, detail, createdAt: at, finishedAt: status === "running" ? undefined : at });
const unknown = { state: "unknown" as const, at: null, waiting: null };
const loops = [{ id: "rei-morning-refresh", enabled: true, available: true }, { id: "bank-references", enabled: false, available: true }];
const until = async (test: () => boolean) => { for (let i = 0; i < 500 && !test(); i++) await new Promise(resolve => setTimeout(resolve, 2)); };

describe("Desk's REI sign-in line", () => {
  it("needs a sign-in while a REI run waits at REI's sign-in page or the morning refresh missed it, and names that work", () => {
    const waiting = run("bank-references", "running", "Sign in to REI Cloud so Bud can finish the bank import. REI's sign-in page is open in the work browser; Bud carries on by itself once you're signed in (waiting until 6:00 pm on Thu 8 Oct).");
    const missed = run("rei-morning-refresh", "missed", `${REI_SIGN_IN_MISSED} REI isn't signed in, so nothing was read.`);
    expect(reiSignInView(unknown, loops, [waiting, missed, run("weekly-bills", "completed", "Done")], NOW)).toEqual({
      state: "needed", at: null, used: true, signingIn: false,
      waiting: [{ loopId: "bank-references", name: "Bank reference review" }, { loopId: "rei-morning-refresh", name: "REI morning refresh" }] });
    // A sign-in seen after the miss wins; a newer successful refresh replaces the miss.
    expect(reiSignInView({ state: "signed_in", at: NOW - 1_000, waiting: null }, loops, [waiting, missed], NOW)).toMatchObject({ state: "signed_in", waiting: [] });
    expect(reiSignInView(unknown, loops, [missed, run("rei-morning-refresh", "completed", "Read REI", NOW - 1_000)], NOW).state).toBe("unknown");
    // A miss from more than 12 hours ago, or a refresh that missed for another reason, is not today's sign-in.
    expect(reiSignInView(unknown, loops, [run("rei-morning-refresh", "missed", REI_SIGN_IN_MISSED, NOW - REI_SIGNED_IN_FRESH_MS - 1)], NOW).state).toBe("unknown");
    expect(reiSignInView(unknown, loops, [run("rei-morning-refresh", "missed", "Missed: more than one REI tab is open.")], NOW).state).toBe("unknown");
  });

  it("reads a sign-in older than 12 hours as not checked, and is quiet for an office that does not use REI", () => {
    expect(reiSignInView({ state: "signed_in", at: NOW - REI_SIGNED_IN_FRESH_MS, waiting: null }, loops, [], NOW)).toMatchObject({ state: "unknown", at: null, used: true });
    expect(reiSignInView({ state: "signed_in", at: NOW - 5_000, waiting: null }, [], [], NOW)).toMatchObject({ state: "signed_in", at: NOW - 5_000, used: true });
    expect(reiSignInView(unknown, [{ id: "weekly-bills", enabled: true }], [], NOW).used).toBe(false);
    expect(reiSignInView({ state: "needed", at: null, waiting: "fictional" }, [], [], NOW)).toMatchObject({ state: "needed", used: true, signingIn: true });
  });

  it("after a sign-in, runs again only a REI morning refresh that is on and missed for sign-in today", () => {
    const missed = run("rei-morning-refresh", "missed", `${REI_SIGN_IN_MISSED} REI isn't signed in.`);
    expect(reiLoopsToResume(loops, [missed], NOW)).toEqual(["rei-morning-refresh"]);
    expect(reiLoopsToResume([{ ...loops[0], enabled: false }], [missed], NOW)).toEqual([]);
    expect(reiLoopsToResume(loops, [run("rei-morning-refresh", "completed", "Read REI", NOW), missed], NOW)).toEqual([]);
    expect(reiLoopsToResume(loops, [run("rei-morning-refresh", "missed", REI_SIGN_IN_MISSED, NOW - REI_SIGNED_IN_FRESH_MS)], NOW)).toEqual([]);
    // A W1 run waiting at sign-in carries on through its own handover: never started twice.
    expect(reiLoopsToResume([...loops, { id: "bank-references", enabled: true, available: true }], [run("bank-references", "running", "Sign in to REI Cloud so Bud can finish the bank import.")], NOW)).toEqual([]);
  });

  it("reruns the missed refresh only once the work browser is free, so the bank import that waited goes first", async () => {
    vi.useFakeTimers();
    try {
      const ran: string[] = []; let busy = true, due = ["rei-morning-refresh"];
      resumeReiWhenFree({ due: () => due, busy: async () => busy, run: id => { ran.push(id); due = []; }, firstMs: 1_000, everyMs: 1_000, tries: 5 });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(ran).toEqual([]);
      busy = false; await vi.advanceTimersByTimeAsync(1_000);
      expect(ran).toEqual(["rei-morning-refresh"]);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(ran).toHaveLength(1);
      // A browser that never frees up gives up after its tries.
      const never: string[] = [];
      resumeReiWhenFree({ due: () => ["rei-morning-refresh"], busy: async () => true, run: id => never.push(id), firstMs: 1_000, everyMs: 1_000, tries: 3 });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(never).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it("learns REI's sign-in from the morning refresh: read whole is signed in, a sign-in miss (whole or part-way) is not", () => {
    noteReiRefresh({ status: "completed", detail: "Read REI." }, NOW);
    expect(siteSignInState(REI_SITE)).toEqual({ state: "signed_in", at: NOW, waiting: null });
    noteReiRefresh({ status: "partial", detail: `REI signed out part-way. Fresh from REI this run: tenants. ${REI_SIGN_IN_MISSED} Bud never signs in for you.` }, NOW + 1);
    expect(siteSignInState(REI_SITE)).toEqual({ state: "needed", at: NOW + 1, waiting: null });
    noteReiRefresh({ status: "missed", detail: "Missed: more than one REI tab is open (rei.fictional.test), so Bud didn't choose one." }, NOW + 2);
    noteReiRefresh({ status: "failed", detail: "Save the REI business code first." }, NOW + 3);
    expect(siteSignInState(REI_SITE).at).toBe(NOW + 1);
  });
});

describe("Desk's Sign in to REI", () => {
  it("opens REI's own sign-in page once, brings that same page forward when pressed again, and records the sign-in", async () => {
    let address = "https://signin.rei.fictional.test/authorize";
    const opened: string[] = [], shown: string[] = [];
    const runtime = { openSignInTab: async (url: string) => { opened.push(url); return "FICTIONALREI1"; }, signInTabUrl: async () => address,
      showSignInTab: async (id: string) => { shown.push(id); return true; } };
    let settled: Promise<unknown> | undefined;
    const open = (input: { site: string; reason: string; threadId: string }) => (settled = openForSignIn(input, { runtime, sites: [rei], pollMs: 1 }));
    noteSiteSignIn(REI_SITE, false, NOW);
    expect(await startReiSignIn(open)).toEqual({ opened: "new" });
    expect(opened).toEqual(["https://rei.fictional.test/"]);
    expect(signInHandovers(REI_DESK_THREAD)).toMatchObject([{ site: REI_SITE, state: "waiting" }]);
    expect(siteSignInState(REI_SITE).state).toBe("needed");
    // Pressed again (or from the status bar): the same tab comes forward; no second REI tab.
    expect(await startReiSignIn(open)).toEqual({ opened: "existing" });
    expect([opened.length, shown]).toEqual([1, ["FICTIONALREI1"]]);
    // The person signs in on REI's page: RealBud sees only the address.
    address = "https://rei.fictional.test/customers/dashboard";
    await settled;
    await until(() => siteSignInState(REI_SITE).state === "signed_in");
    expect(siteSignInState(REI_SITE)).toMatchObject({ state: "signed_in", waiting: null });
  });

  it("opens the page again in a new tab once the waiting one was closed", async () => {
    const opened: string[] = [];
    let tab = "FICTIONALREI2";
    const runtime = { openSignInTab: async () => { opened.push(tab); return tab; }, signInTabUrl: async () => "https://signin.rei.fictional.test/authorize",
      showSignInTab: async (id: string) => id !== "FICTIONALREI2" };
    await startReiSignIn(input => openForSignIn(input, { runtime, sites: [rei], pollMs: 1 }));
    tab = "FICTIONALREI3";
    expect(await startReiSignIn(undefined)).toEqual({ opened: "existing" });
    expect(opened).toEqual(["FICTIONALREI2", "FICTIONALREI3"]);
    const [view] = signInHandovers(REI_DESK_THREAD).filter(item => item.state === "waiting");
    expect(browserSignInRoute(`/api/browser/sign-in/${view.id}/stop`, "POST", new URLSearchParams())?.status).toBe(200);
    await until(() => siteSignInState(REI_SITE).waiting === null);
    expect(siteSignInState(REI_SITE).state).toBe("needed");
  });

  it("says plainly when the work browser can't open REI, and when this computer has no REI sign-in", async () => {
    await expect(startReiSignIn(async () => { throw new Error("fictional CDP failure"); })).rejects.toMatchObject({
      status: 409, message: "The work browser couldn't open REI's sign-in page. Open Workspace → Work browser, then try again." });
    await expect(startReiSignIn(undefined)).rejects.toMatchObject({ status: 409, message: "REI sign-in isn't available on this computer yet." });
  });
});
