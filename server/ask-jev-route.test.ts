import { describe, expect, it, vi } from "vitest";
import type { JevRequest, JevResult } from "./jev-client.ts";
import { ASK_JEV_MAX_TEXT, ASK_JEV_TIMEOUT_MS, askJevRoute, chooseAskRoute, personAskTurn, type AskJevRoute } from "./ask-jev-route.ts";
import { askControlReply, parseAskControlIntent } from "./ask-control-intent.ts";
import { isAskProductControl } from "../shared/ask-controls.ts";
import { scheduleIntentReply } from "./schedule-intent.ts";

const answer = (choice: string, confidence = 0.98, probabilities: Record<string, number> | null = { [choice]: confidence, bud: 1 - confidence }): JevResult =>
  ({ ok: true, model: "fictional-jev", ms: 5, answers: { route: { type: "choice", choice, confidence, ...(probabilities ? { probabilities } : {}) } } });
const fixed = (result: JevResult) => vi.fn(async (_request: JevRequest, _options?: { timeoutMs?: number }) => result);

// Fictional labelled cases: every one misses the regex controls, so Jev decides it.
// null = Bud. scripts/eval-jev can run these against the real route to tune thresholds.
const CASES: Array<[string, AskJevRoute | null]> = [
  ["which jobs run on their own each week", "schedule-status"],
  ["what routines does Bud run for us", "schedule-status"],
  ["anything set to run automatically tomorrow morning", "schedule-status"],
  ["do you have access to our outlook", "connected-status"],
  ["which accounts can Bud see right now", "connected-status"],
  ["how would I hook up MYOB", "connections"],
  ["where do I add a new app like Dropbox", "connections"],
  ["Bud keeps saying it isn't ready, what do I do", "setup"],
  ["how do I finish Bud's setup", "setup"],
  ["how do I turn on the bank feed", "bank-feed"],
  ["can you change my morning schedule to 7am", null],
  ["move the owner letters to Fridays", null],
  ["turn off the morning priorities loop", null],
  ["run the arrears check now", null],
  ["disconnect Gmail", null],
  ["send the rent reminder to the tenant at 14 Sample Street", null],
  ["what's the arrears balance for 3 Example Road", null],
  ["is the water connected at 9 Fictional Lane", null],
  ["approve the plumber's invoice", null],
  ["pay the strata levy for unit 4", null],
  ["show connected apps and then email the owner", null],
  ["what did the bank feed show for rent yesterday", null],
];
const oracle = vi.fn(async (request: JevRequest) => answer(CASES.find(([text]) => text === request.state)?.[1] ?? "bud"));

describe("Jev pre-route for Ask", () => {
  it.each(CASES)("routes the labelled case %j to %s", async (text, expected) => {
    expect(isAskProductControl(text) || scheduleIntentReply(text)).toBeFalsy();
    expect(await askJevRoute(text, { person: true, ready: () => true, decide: oracle })).toBe(expected);
  });

  it("sends only the message text, one choice with a Bud option, and a small timeout", async () => {
    const decide = fixed(answer("setup"));
    await chooseAskRoute("  how do I finish Bud's setup  ", decide);
    const [request, options] = decide.mock.calls[0]!;
    expect(request.state).toBe("how do I finish Bud's setup");
    expect(Object.keys(request.questions)).toEqual(["route"]);
    const question = request.questions.route!;
    expect(question.type === "choice" && Object.keys(question.criteria)).toEqual(["schedule-status", "connected-status", "connections", "setup", "bank-feed", "bud"]);
    expect(options).toEqual({ timeoutMs: ASK_JEV_TIMEOUT_MS });
  });

  it("gives exactly the reply the regex gives for the same control", async () => {
    const routed = await chooseAskRoute("which jobs run on their own each week", fixed(answer("schedule-status")));
    const loops = [{ name: "Morning money check", enabled: true, schedule: { time: "08:00", weekdays: [1, 3] } }];
    expect(askControlReply(routed as "schedule-status", loops)).toBe(askControlReply(parseAskControlIntent("what is scheduled?")!, loops));
  });

  it.each([
    ["low confidence", answer("setup", 0.9)],
    ["low margin", answer("setup", 0.96, { setup: 0.6, connections: 0.35, bud: 0.05 })],
    ["no probabilities", answer("setup", 0.99, null)],
    ["Bud", answer("bud")],
    ["a control that changes things", answer("schedule-edit")],
    ["a failure", { ok: false, reason: "http" } as JevResult],
    ["a timeout", { ok: false, reason: "timeout" } as JevResult],
    ["no budget", { ok: false, reason: "budget" } as JevResult],
  ])("goes to Bud on %s", async (_label, result) => {
    expect(await chooseAskRoute("how do I finish Bud's setup", fixed(result))).toBeNull();
  });

  it("goes to Bud when decide throws", async () => {
    expect(await chooseAskRoute("how do I finish Bud's setup", vi.fn(async () => { throw new Error("boom"); }))).toBeNull();
  });

  it.each([
    ["long text", "x".repeat(ASK_JEV_MAX_TEXT + 1)],
    ["an attached file", 'how do I finish setup <attached-file path="/synthetic/a.pdf" />'],
    ["pasted text", "<pasted-text index=\"1\">what is scheduled</pasted-text>"],
    ["several lines", "Here is an email:\nshow connected apps"],
    ["blank text", "   "],
  ])("never calls Jev for %s", async (_label, text) => {
    const decide = fixed(answer("setup"));
    expect(await chooseAskRoute(text, decide)).toBeNull();
    expect(decide).not.toHaveBeenCalled();
  });

  it.each(["what is scheduled?", "Pause the schedule", "what are we connected to?", "connect notion", "check xero connection", "How do I set up Bud?", "connect to redbark", "can you set up a rent check every Monday"])(
    "a regex control skips Jev: %s", async text => {
      const decide = fixed(answer("setup"));
      expect(await askJevRoute(text, { person: true, ready: () => true, decide })).toBeNull();
      expect(decide).not.toHaveBeenCalled();
    });

  it("never runs for a message the person did not type, or when Jev is not ready", async () => {
    const decide = fixed(answer("setup"));
    expect(await askJevRoute("how do I finish Bud's setup", { person: false, ready: () => true, decide })).toBeNull();
    expect(await askJevRoute("how do I finish Bud's setup", { person: true, ready: () => false, decide })).toBeNull();
    expect(decide).not.toHaveBeenCalled();
  });

  it("reaches Jev only for a person's own Ask, never a channel relay, a queued follow-up or an attended job turn", () => {
    // The exact opts each caller of startTurn passes (server/index.ts, server/channels/*.ts).
    expect(personAskTurn({ personAsk: true })).toBe(true);
    expect(personAskTurn({ personAsk: true, memberSession: "fictional-member-session", threadId: "t-1" } as Parameters<typeof personAskTurn>[0])).toBe(true);
    expect(personAskTurn({ channelRelay: true })).toBe(false);
    expect(personAskTurn({ personAsk: true, channelRelay: true })).toBe(false);
    expect(personAskTurn({ threadId: "t-1" } as Parameters<typeof personAskTurn>[0])).toBe(false);
    expect(personAskTurn({ systemExtra: "Attended job block" })).toBe(false);
    expect(personAskTurn({ personAsk: true, systemExtra: "Attended job block" })).toBe(false);
    expect(personAskTurn(undefined)).toBe(false);
  });
});
