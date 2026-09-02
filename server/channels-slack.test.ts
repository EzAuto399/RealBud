// Slack channel: verify, pair on first DM, Ask relay, allow/deny text.
import { rmSync } from "node:fs";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SlackDeps, SlackFetch, StartTurnFn } from "./channels/slack.ts";
import type { Draft } from "../shared/contracts.ts";

const dataDir = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMPDIR || process.cwd();
  const dir = `${base}/realbud-slack-${process.pid}-${Date.now().toString(36)}`;
  process.env.REALBUD_DATA_DIR = dir;
  return dir;
});

const { Store } = await import("./store.ts");
const slack = await import("./channels/slack.ts");
const remote = await import("./remote-decisions.ts");

const TOKEN = "xoxb-SuperSecretSlackBotTokenXYZ";

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function stubFetch(opts?: {
  auth?: { user: string; user_id: string } | "fail";
  onPost?: (channel: string, text: string) => void;
}): SlackFetch {
  return async (input, init) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (url.includes("/api/auth.test")) {
      if (opts?.auth === "fail") return jsonRes({ ok: false, error: "invalid_auth" });
      return jsonRes({
        ok: true,
        user: opts?.auth?.user ?? "realbud",
        user_id: opts?.auth?.user_id ?? "U_BOT",
      });
    }
    if (url.includes("/api/chat.postMessage")) {
      opts?.onPost?.(String(body.channel ?? ""), String(body.text ?? ""));
      return jsonRes({ ok: true, ts: "1.0" });
    }
    if (url.includes("/api/users.info")) {
      return jsonRes({
        ok: true,
        user: { id: body.user, name: "sam", real_name: "Sam Office", profile: { real_name: "Sam Office" } },
      });
    }
    return jsonRes({ ok: false, error: "unknown_method" }, 404);
  };
}

function makeStore(): InstanceType<typeof Store> {
  const store = new Store(() => ({ instanceId: "", model: "" }));
  store.seedIfEmpty();
  return store;
}

function deps(partial: Partial<SlackDeps> & { fetch: SlackFetch; startTurn?: StartTurnFn }): SlackDeps {
  const store = partial.store ?? makeStore();
  return {
    store,
    startTurn: partial.startTurn ?? (async () => undefined),
    subscribe: partial.subscribe ?? (() => () => undefined),
    broadcast: partial.broadcast,
    fetch: partial.fetch,
    now: partial.now ?? (() => 1_700_000_000_000),
  };
}

beforeEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  slack.stopSlackBridge();
  slack.deleteChannel();
  remote.resetRemoteDecisions();
});

afterEach(() => {
  slack.stopSlackBridge();
  slack.deleteChannel();
  remote.resetRemoteDecisions();
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("Slack channel", () => {
  it("rejects a bad bot token without writing channel-slack.json", async () => {
    await expect(slack.connectSlack(TOKEN, null, stubFetch({ auth: "fail" }))).rejects.toThrow(/did not answer/i);
    expect(slack.loadChannel()).toBeNull();
  });

  it("connects, pairs on the first DM, and refuses a second chat", async () => {
    const posts: Array<{ channel: string; text: string }> = [];
    const d = deps({
      fetch: stubFetch({
        onPost: (channel, text) => posts.push({ channel, text }),
      }),
    });
    slack.bindSlackBridge(d);
    await slack.connectSlack(TOKEN, null, d.fetch);

    await slack.handleSlackInbound(
      [{ channelId: "D_PAIR", userId: "U_SAM", name: "Sam Office", text: "hello", ts: "10.1" }],
      d,
    );
    expect(slack.loadChannel()?.pairedChannelId).toBe("D_PAIR");
    expect(slack.loadChannel()?.pairedName).toBe("Sam Office");
    expect(posts.some((p) => p.text.includes("Paired with RealBud"))).toBe(true);

    await slack.handleSlackInbound(
      [{ channelId: "D_OTHER", userId: "U_OTHER", name: "Other", text: "hi", ts: "11.1" }],
      d,
    );
    expect(posts.some((p) => p.channel === "D_OTHER" && p.text.includes("paired elsewhere"))).toBe(true);
  });

  it("treats allow in the paired DM as the pending decision", async () => {
    const decided: Array<{ id: string; via?: string; status: string; reason?: string }> = [];
    const posts: string[] = [];
    const drafts: Draft[] = [
      {
        id: "d-oak",
        propertyId: "prop-oak",
        kind: "courtesy-rent",
        status: "pending",
        channel: "sms",
        to: "0400",
        body: "Hi",
        periodDueAt: 1,
        createdAt: 1,
      },
    ];
    const fetchFn = stubFetch({ onPost: (_c, text) => posts.push(text) });
    const d = deps({ fetch: fetchFn });
    slack.bindSlackBridge(d);
    await slack.connectSlack(TOKEN, null, fetchFn);
    await slack.handleSlackInbound(
      [{ channelId: "D_PAIR", userId: "U_SAM", name: "Sam", text: "hi", ts: "1.0" }],
      d,
    );

    remote.bindRemoteDecisions({
      desk: {
        snapshot: () =>
          ({
            version: 2,
            revision: 1,
            mode: "demo",
            recovery: { active: false, reason: null, quarantined: [] },
            timezone: "Australia/Sydney",
            retentionDays: null,
            properties: [
              {
                id: "prop-oak",
                address: "12 Oak St, Dickson ACT",
                tenantName: "Jordan",
                tenantPhone: "0400",
                weeklyRentCents: 1,
                options: {
                  rentSource: "fixture",
                  graceDays: 3,
                  courtesyUntilDay: 7,
                  levyFromRent: null,
                  notifyChannel: "sms",
                  never: [],
                },
              },
            ],
            ledger: [],
            drafts,
            escalations: [],
            workItems: [],
            lastRunAt: null,
            results: [],
            hands: "demo",
            handsDetail: null,
            sources: [],
            demo: true,
          }) as never,
        allowDraft(id: string, _expected: number, via?: string) {
          drafts[0]!.status = "allowed";
          drafts[0]!.via = via;
          decided.push({ id, via, status: "allowed" });
          return drafts[0]!;
        },
        denyDraft(id: string, _expected: number, via?: string, reason?: string) {
          drafts[0]!.status = "denied";
          drafts[0]!.via = via;
          decided.push({ id, via, status: "denied" });
          if (reason) decided.push({ id: "note", status: "note", reason });
          return drafts[0]!;
        },
        notesFor() {
          return { id: "prop-oak", body: "" };
        },
        writeNotes() {
          return { id: "prop-oak", body: "" };
        },
      },
      commit: (snap) => remote.notifyDeskSnapshot(snap),
      channels: [slack.slackDecisionAdapter()],
      now: () => Date.UTC(2026, 7, 31, 0, 0, 0),
    });
    await remote.notifyDeskSnapshot({
      version: 2,
      revision: 1,
      mode: "demo",
      recovery: { active: false, reason: null, quarantined: [] },
      timezone: "Australia/Sydney",
      retentionDays: null,
      properties: [],
      ledger: [],
      drafts,
      escalations: [],
      workItems: [],
      lastRunAt: null,
      results: [],
      hands: "demo",
      handsDetail: null,
      sources: [],
      demo: true,
    } as never);

    expect(remote.pendingDraftId("slack")).toBe("d-oak");
    const startTurn = vi.fn(async () => {});
    await slack.handleSlackInbound(
      [{ channelId: "D_PAIR", userId: "U_SAM", name: "Sam", text: "allow", ts: "2.0" }],
      { ...d, startTurn },
    );
    expect(decided[0]).toMatchObject({ id: "d-oak", status: "allowed", via: "via Slack · Sam" });
    expect(posts.some((text) => /^Allowed via Slack · Sam · /.test(text))).toBe(true);
    expect(startTurn).not.toHaveBeenCalled();
  });

  it("never echoes the bot token in the public status", async () => {
    await slack.connectSlack(TOKEN, null, stubFetch());
    const pub = slack.slackAdapter.status();
    expect(pub).toEqual({
      connected: true,
      botUsername: "realbud",
      pairedName: null,
      paired: false,
      lastMessageAt: null,
    });
    expect(JSON.stringify(pub)).not.toContain(TOKEN);
  });
});
