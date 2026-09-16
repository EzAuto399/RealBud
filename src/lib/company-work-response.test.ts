import { describe, expect, it } from "vitest";
import { parseSharedWorkHistory, parseSharedWorkItemResponse, parseSharedWorkList, parseWorkMembers } from "./company-work-response";

const person = { id: "m1", displayName: "Ada" };
const item = {
  id: "w1",
  scopeId: "c1",
  revision: "1",
  title: "Q3 summary",
  summary: "Reviewed notes",
  purpose: "share-result",
  state: "open",
  owner: person,
  assignee: null,
  audience: [person],
  response: "",
  updatedBy: person,
  updatedAt: "2026-09-15T12:00:00.000Z",
  actions: { respond: false, close: true },
};

describe("company-work-response", () => {
  it("parses members and omits credential fields", () => {
    const result = parseWorkMembers({
      members: [{ ...person, memberToken: "secret-token", password: "hunter2" }],
      recoveryKey: "rk",
      invitationToken: "inv",
    });
    expect(result).toEqual({ members: [person] });
    expect(JSON.stringify(result)).not.toMatch(/memberToken|password|recoveryKey|invitationToken|hunter2|secret-token/);
  });

  it("parses items and does not reflect unknown credentials", () => {
    const result = parseSharedWorkItemResponse({
      item: { ...item, assignee: { id: "m2", displayName: "Bo", recoveryKey: "rk" }, token: "abc" },
      memberToken: "session",
    });
    expect(result).toEqual({ item: { ...item, assignee: { id: "m2", displayName: "Bo" } } });
    expect(JSON.stringify(result)).not.toMatch(/recoveryKey|memberToken|"token"/);
  });

  it("parses a bounded work list", () => {
    expect(parseSharedWorkList({ items: [item] })).toEqual({ items: [item] });
  });

  it("keeps older hosts readable without guessing permission from audience membership", () => {
    const { actions: _actions, ...legacy } = item;
    expect(parseSharedWorkItemResponse({ item: legacy }).item.actions).toEqual({ respond: false, close: false });
    expect(() => parseSharedWorkItemResponse({ item: { ...item, actions: { respond: 'true', close: false } } })).toThrow(/incomplete response/);
    expect(() => parseSharedWorkItemResponse({ item: { ...item, actions: null } })).toThrow(/incomplete response/);
  });

  it("rejects wrong shapes and unbounded values", () => {
    const reject = (run: () => unknown) => expect(run).toThrow(/incomplete response/);
    reject(() => parseWorkMembers(null));
    reject(() => parseWorkMembers([]));
    reject(() => parseWorkMembers({ members: [{ id: "m1", displayName: "" }] }));
    reject(() => parseWorkMembers({ members: Array.from({ length: 101 }, (_, index) => ({ id: `m${index}`, displayName: "Ada" })) }));
    reject(() => parseSharedWorkList({ items: "nope" }));
    reject(() => parseSharedWorkList({ items: Array.from({ length: 11 }, () => item) }));
    reject(() => parseSharedWorkItemResponse({ items: [item] }));
    reject(() => parseSharedWorkItemResponse({ item: { ...item, purpose: "execute" } }));
    reject(() => parseSharedWorkItemResponse({ item: { ...item, state: "paid" } }));
    reject(() => parseSharedWorkItemResponse({ item: { ...item, summary: "a".repeat(8001) } }));
    reject(() => parseSharedWorkItemResponse({ item: { ...item, title: "bad\0title" } }));
    reject(() => parseSharedWorkItemResponse({ item: { ...item, updatedAt: "soon" } }));
    reject(() => parseSharedWorkItemResponse({ item: { ...item, revision: 1 } }));
    reject(() => parseSharedWorkItemResponse({
      item: { ...item, audience: Array.from({ length: 101 }, (_, index) => ({ id: `m${index}`, displayName: "Ada" })) },
    }));
    reject(() => parseSharedWorkItemResponse({ item: { ...item, assignee: { id: "m2" } } }));
    reject(() => parseSharedWorkItemResponse({ item: { ...item, owner: null } }));
  });
  it('validates new handoff authority and portable evidence without retaining unknown fields', () => {
    const evidence = { label: 'Reviewed bill', sourceRef: 'training-message-7', sourceVersion: 'v1', text: 'AUD 120.00', sha256: 'a'.repeat(64) };
    expect(parseSharedWorkItemResponse({ item: { ...item, state: 'accepted', acceptedBy: person, evidence: { ...evidence, privateToken: 'secret' }, actions: { ...item.actions, accept: false, reassign: true, addRecipient: true } } }).item.evidence).toEqual(evidence);
    for (const extra of [{ evidence: { ...evidence, sha256: 'not-a-hash' } }, { evidence: { ...evidence, text: 'x'.repeat(8001) } },
      { acceptedBy: { id: 'x' } }, { ownerAvailable: 'yes' }, { actions: { ...item.actions, accept: 'yes' } }]) {
      expect(() => parseSharedWorkItemResponse({ item: { ...item, ...extra } })).toThrow(/incomplete response/);
    }
  });
  it('bounds activity pages and does not copy private metadata into history', () => {
    const event = { revision: '2', action: 'accepted', actor: person, at: item.updatedAt, assignee: person, response: '' };
    expect(parseSharedWorkHistory({ events: [{ ...event, credential: 'secret' }], hasMore: false })).toEqual({ events: [event], hasMore: false });
    for (const page of [{ events: Array(21).fill(event), hasMore: true }, { events: [{ ...event, action: 'paid' }], hasMore: false },
      { events: [event], hasMore: 'yes' }, { events: [{ ...event, response: 'x'.repeat(4001) }], hasMore: false }]) {
      expect(() => parseSharedWorkHistory(page)).toThrow(/incomplete response/);
    }
  });
});
