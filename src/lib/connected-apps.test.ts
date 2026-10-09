import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activeConnectedAccounts, canPrepareConnectedEmail, connectedAppOperationContext, connectedEmailContext, needsAttention, needsEarlierConnectionCheck, needsOwnerCheck, operationsToShow,
  readConnectedAppOperations, readConnectedAppsStatus, selectedConnectedAccount, type ConnectedAppsStatus,
} from "./connected-apps";
import { fileAttachment } from "./composer-attachments";
import { mergeWorkContext } from "./work-continuation";

const NOW = Date.parse("2026-09-08T01:00:00.000Z");
beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(NOW); });
afterEach(() => { vi.restoreAllMocks(); });

const status = (checkedAt = NOW): ConnectedAppsStatus => ({
  configured: true, checkedAt: new Date(checkedAt).toISOString(),
  services: { gmail: { connected: true, status: "ACTIVE", accounts: [{ id: "office-1", label: "Office mailbox", status: "ACTIVE" }], accountSelectionRequired: false } },
  tools: { available: true, names: ["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_MULTI_EXECUTE_TOOL"] },
});

describe("connected email setup and account choice", () => {
  it("keeps a saved key separate from verified access and identifiable active accounts", () => {
    expect(canPrepareConnectedEmail(status(), "gmail")).toBe(true);
    expect(canPrepareConnectedEmail(status(), "outlook")).toBe(false);
    for (const snapshot of [null, { ...status(), configured: false }, { ...status(), checkedAt: "" }, { ...status(), checkedAt: "invalid" },
      { ...status(), error: "Status check failed" }, { ...status(), tools: { available: false, names: [] } }, { ...status(), tools: { available: true, names: [] } },
      { ...status(), services: { gmail: { ...status().services.gmail, connected: false } } },
      { ...status(), services: { gmail: { ...status().services.gmail, accounts: [] } } }]) {
      expect(canPrepareConnectedEmail(snapshot, "gmail")).toBe(false);
    }
  });

  it("requires an explicit active account choice when the provider reports ambiguity", () => {
    const snapshot = status();
    snapshot.services.gmail.accounts.push({ id: "personal-2", status: "active" });
    snapshot.services.gmail.accountSelectionRequired = true;
    expect(canPrepareConnectedEmail(snapshot, "gmail")).toBe(false);
    expect(canPrepareConnectedEmail(snapshot, "gmail", "personal-2")).toBe(true);
    expect(canPrepareConnectedEmail(snapshot, "gmail", "removed-account")).toBe(false);
    snapshot.services.gmail.accounts[1].status = "INACTIVE";
    expect(canPrepareConnectedEmail(snapshot, "gmail", "personal-2")).toBe(false);
    expect(selectedConnectedAccount(snapshot.services.gmail)).toBeNull();
    expect(activeConnectedAccounts(snapshot.services.gmail)).toHaveLength(1);
    expect(canPrepareConnectedEmail(snapshot, "gmail", "office-1")).toBe(true);
  });

  it('keeps manual mail evidence separate from an unknown provider outcome and omits protected account/review material', () => {
    const row = { id: 'operation', threadId: 'thread', toolName: 'GMAIL_SEND_EMAIL', toolSlugs: [], status: 'unknown', startedAt: new Date(NOW).toISOString(), detail: 'Outcome needs checking', revision: 2,
      accountDigest: 'a'.repeat(64), originalReview: { card: 'PRIVATE ORIGINAL' }, reconciliation: { outcome: 'not-sent', source: 'manual-app-inspection', at: NOW + 1, recoveryBindingDigest: 'b'.repeat(64) } };
    const parsed = readConnectedAppOperations({ operations: [row] })[0];
    expect(parsed.status).toBe('unknown'); expect(parsed.reconciliation).toEqual({ outcome: 'not-sent', source: 'manual-app-inspection', at: new Date(NOW + 1).toISOString() });
    expect(parsed).not.toHaveProperty('accountDigest'); expect(JSON.stringify(parsed)).not.toContain('PRIVATE ORIGINAL');
    expect(() => readConnectedAppOperations({ operations: [{ ...row, status: 'succeeded' }] })).toThrow();
    expect(() => readConnectedAppOperations({ operations: [{ ...row, reconciliation: { ...row.reconciliation, source: 'provider-confirmed' } }] })).toThrow();
    expect(() => readConnectedAppOperations({ operations: [{ ...row, revision: -1 }] })).toThrow();
  });
  it('reads the owner check on a receipt without account details and keeps every held receipt visible', () => {
    const at = (offset: number) => new Date(NOW - offset).toISOString();
    const legacy = { id: 'older', threadId: 'thread', toolName: 'GMAIL_SEND_EMAIL', toolSlugs: [], status: 'unknown', startedAt: at(86_400_000), revision: 1 };
    const identified = { ...legacy, id: 'identified', startedAt: at(10), effectDigest: 'c'.repeat(64) };
    const recent = Array.from({ length: 6 }, (_, index) => ({ ...legacy, id: `recent-${index}`, status: 'succeeded', finishedAt: at(index), startedAt: at(index) }));
    const parsed = readConnectedAppOperations({ operations: [legacy, identified, ...recent] });
    expect(parsed.find(row => row.id === 'identified')).toMatchObject({ identified: true });
    expect(parsed.find(row => row.id === 'identified')).not.toHaveProperty('effectDigest');
    expect(parsed.filter(needsOwnerCheck).map(row => row.id)).toEqual(['older']);
    // The Recent activity summary counts both as needing checking.
    expect(parsed.filter(needsAttention).map(row => row.id)).toEqual(['identified', 'older']);
    // Held receipts come first, ahead of newer activity, however old they are.
    expect(operationsToShow(parsed).map(row => row.id)).toEqual(['identified', 'older', 'recent-0', 'recent-1', 'recent-2', 'recent-3', 'recent-4']);
    const checked = readConnectedAppOperations({ operations: [{ ...legacy, revision: 2, acknowledgement: { at: NOW, source: 'owner-checked-app' } }] })[0];
    expect(checked.acknowledgement).toEqual({ at: new Date(NOW).toISOString() }); expect(needsOwnerCheck(checked)).toBe(false);
    for (const bad of [{ status: 'failed' }, { effectDigest: 'c'.repeat(64), status: 'started' }, { effectDigest: 'c'.repeat(64), status: 'succeeded' }, { acknowledgement: { at: NOW, source: 'model' } }])
      expect(() => readConnectedAppOperations({ operations: [{ ...legacy, acknowledgement: { at: NOW, source: 'owner-checked-app' }, ...bad }] })).toThrow();
  });
  it('loads an owner-checked send from an earlier company or gateway and stops asking about it', () => {
    const at = (offset: number) => new Date(NOW - offset).toISOString();
    const earlier = { id: 'earlier', threadId: 'thread', toolName: 'GMAIL_SEND_EMAIL', toolSlugs: [], status: 'unknown', startedAt: at(86_400_000), revision: 1, effectDigest: 'c'.repeat(64) };
    const checked = { ...earlier, id: 'checked', revision: 2, acknowledgement: { at: NOW, source: 'owner-checked-app' } };
    const failedChecked = { ...checked, id: 'failed-checked', status: 'failed', finishedAt: at(5) };
    const parsed = readConnectedAppOperations({ operations: [earlier, checked, failedChecked] });
    expect(parsed.find(row => row.id === 'checked')).toMatchObject({ identified: true, acknowledgement: { at: new Date(NOW).toISOString() } });
    expect(parsed.find(row => row.id === 'failed-checked')).toMatchObject({ identified: true, status: 'failed' });
    // Only the unchecked one still leads the list as needing the owner.
    expect(operationsToShow(parsed, 0).map(row => row.id)).toEqual(['earlier']);
  });
  it('offers the owner check only for an unconfirmed identified send Inspect named as from an earlier connection', () => {
    const base = { id: 'earlier', threadId: 'thread', toolName: 'GMAIL_SEND_EMAIL', toolSlugs: [], status: 'unknown' as const, startedAt: new Date(NOW).toISOString(), identified: true };
    const refused = new Set(['earlier']);
    expect(needsEarlierConnectionCheck(base, refused)).toBe(true);
    expect(needsEarlierConnectionCheck({ ...base, status: 'failed' }, refused)).toBe(true);
    expect(needsEarlierConnectionCheck(base, new Set())).toBe(false);
    for (const other of [{ status: 'started' as const }, { status: 'succeeded' as const }, { identified: undefined }, { acknowledgement: { at: base.startedAt } },
      { reconciliation: { outcome: 'sent' as const, at: base.startedAt, source: 'manual-app-inspection' as const } }])
      expect(needsEarlierConnectionCheck({ ...base, ...other }, refused)).toBe(false);
  });
  it("expires access at the action boundary and rejects future or invalid clocks", () => {
    expect(canPrepareConnectedEmail(status(), "gmail", "", NOW + 300_000)).toBe(true);
    for (const now of [NOW + 300_001, NOW - 1, Infinity, NaN]) {
      expect(canPrepareConnectedEmail(status(), "gmail", "", now)).toBe(false);
      expect(connectedEmailContext(status(), "gmail", "office-1", "stale", now)).toBeNull();
    }
  });

  it("cannot silently switch the selected account after fresh status changes", () => {
    const fresh = status();
    fresh.services.gmail.accounts = [{ id: "different-office", status: "ACTIVE" }];
    expect(connectedEmailContext(fresh, "gmail", "office-1", "changed", NOW)).toBeNull();
    expect(connectedEmailContext({ ...status(), configured: false }, "gmail", "office-1", "removed", NOW)).toBeNull();
  });

  it("does not invent account labels or retain arbitrary provider data", () => {
    const input = status();
    delete input.services.gmail.accounts[0].label;
    const parsed = readConnectedAppsStatus({ ...input, privatePayload: "must not survive", services: {
      gmail: { ...input.services.gmail, accounts: [{ ...input.services.gmail.accounts[0], providerPayload: { token: "fixture-not-a-token" } }] },
    } });
    expect(parsed.services.gmail.accounts[0]).toEqual({ id: "office-1", status: "ACTIVE" });
    expect(JSON.stringify(parsed)).not.toContain("providerPayload");
    expect(JSON.stringify(parsed)).not.toContain("privatePayload");
    expect(readConnectedAppsStatus({ configured: false, checkedAt: "", services: {}, tools: { available: false, names: [] } }).configured).toBe(false);
  });

  it("fails closed for malformed or duplicate account identities without modifying opaque IDs", () => {
    for (const accounts of [[{ id: "", status: "ACTIVE" }], [{ id: "abc\ndef", status: "ACTIVE" }], [{ id: "x".repeat(301), status: "ACTIVE" }], [{ id: "same", status: "ACTIVE" }, { id: "same", status: "ACTIVE" }]]) {
      expect(() => readConnectedAppsStatus({ ...status(), services: { gmail: { ...status().services.gmail, accounts } } })).toThrow(/identity/);
    }
    expect(() => readConnectedAppsStatus({ configured: true, services: {}, tools: null })).toThrow();
    expect(() => readConnectedAppsStatus({ ...status(), services: { gmail: { connected: true, accounts: {} } } })).toThrow();
  });
});

describe("bounded email task handoff", () => {
  it("stages exact account, date and thread scope with no sending or mailbox changes", () => {
    const now = Date.parse("2026-09-08T04:00:00.000Z");
    const context = connectedEmailContext(status(now), "gmail", "", "handoff", now)!;
    expect(context.text).toContain('selected account ID: "office-1"');
    expect(context.text).toContain("2026-09-01T04:00:00.000Z through 2026-09-08T04:00:00.000Z");
    expect(context.text).toContain("Maximum 10 threads in total");
    expect(context.text).toContain("This account choice is advisory");
    expect(context.text).toContain("message IDs or links, source dates");
    expect(context.text).toContain("do not claim to have reviewed the whole inbox");
    expect(context.text).toContain("Do not send messages, create or update mailbox drafts");
    expect(context.text).toContain("No recurring email run is created");
    expect(context.instruction).toContain("Do not send");
    expect(connectedEmailContext(null, "gmail", "", "invalid")).toBeNull();
    expect(connectedEmailContext(status(), "gmail", "", "invalid", Infinity)).toBeNull();
    expect(connectedEmailContext(status(), "gmail", "", "invalid", 1e20)).toBeNull();
  });

  it("preserves existing text and attachments while refreshing repeated scope staging", () => {
    const original = fileAttachment("notes.md", "/workroom/notes.md", 20);
    const first = connectedEmailContext(status(1_000_000_000), "gmail", "", "one", 1_000_000_000)!;
    const merged = mergeWorkContext("My unsent request", [original], first);
    const second = connectedEmailContext(status(1_000_000_000), "gmail", "", "two", 1_000_010_000)!;
    const updated = mergeWorkContext(merged.text, merged.attachments, second);
    expect(updated.text).toBe("My unsent request");
    expect(updated.attachments).toHaveLength(2);
    expect(updated.attachments[0]).toEqual(original);
    expect(updated.attachments[1]).toMatchObject({ id: first.sourceKey, text: second.text });
    expect(mergeWorkContext("", [], first).text).toBe(first.instruction);
  });
});

describe("connected app outcome receipts", () => {
  it("orders outcomes by their actual start and projects only safe product fields", () => {
    const entries = ["2026-09-08T01:00:00Z", "2026-09-08T02:00:00Z"].map((startedAt, index) => ({
      id: `op-${index}`, threadId: "bud-thread", toolName: "COMPOSIO_MULTI_EXECUTE_TOOL", toolSlugs: ["GMAIL_FETCH_EMAILS"],
      status: index ? "unknown" : "succeeded", startedAt, detail: "Recorded app result", arguments: { sensitiveBody: "not retained" },
    }));
    const operations = readConnectedAppOperations({ operations: entries });
    expect(operations.map(row => row.status)).toEqual(["unknown", "succeeded"]);
    expect(JSON.stringify(operations)).not.toContain("sensitiveBody");
    const context = connectedAppOperationContext(operations[0], "review");
    expect(context.instruction).toContain("Do not repeat");
    expect(context.text).toContain("recorded state: unknown");
    expect(context.text).toContain("An allowed request is not proof of success");
    expect(context.text).toContain("check the app before any new action");
  });

  it("does not relabel malformed or unsupported outcomes as success", () => {
    expect(() => readConnectedAppOperations({ operations: [{ id: "op", startedAt: "yesterday", status: "succeeded", toolSlugs: [] }] })).toThrow();
    expect(() => readConnectedAppOperations({ operations: [{ id: "op", startedAt: "2026-09-08T01:00:00Z", status: "approved", toolSlugs: [] }] })).toThrow();
    expect(readConnectedAppOperations({ operations: [] })).toEqual([]);
  });
});


it('projects shared source metadata without claiming an unconnected mailbox is usable', () => {
  const projected = readConnectedAppsStatus({ ...status(), sourceKind: 'office_shared', policyRevision: 7, credential: 'fictional-hidden', services: { gmail: { connected: false, status: 'NOT_CONNECTED', accounts: [], accountSelectionRequired: false } }, tools: { available: false, names: [] } });
  expect(projected.sourceKind).toBe('office_shared'); expect(projected.policyRevision).toBe(7);
  expect(projected).not.toHaveProperty('credential');
  expect(canPrepareConnectedEmail(projected, 'gmail')).toBe(false);
  expect(() => readConnectedAppsStatus({ ...status(), sourceKind: 'office_shared' })).toThrow(/policy/);
});

it('projects the office mailbox beside the own one only in mailbox mode both', () => {
  const office = { connected: true, status: 'ACTIVE', accounts: [{ id: 'office-account', status: 'ACTIVE', token: 'fictional-hidden' }], accountSelectionRequired: false };
  const both = readConnectedAppsStatus({ ...status(), sourceKind: 'personal', policyRevision: 3, mailboxMode: 'both', officeShared: office });
  expect(both.mailboxMode).toBe('both'); expect(both.officeShared).toEqual({ connected: true, status: 'ACTIVE', accounts: [{ id: 'office-account', status: 'ACTIVE' }], accountSelectionRequired: false });
  expect(readConnectedAppsStatus({ ...status(), sourceKind: 'personal', policyRevision: 3, mailboxMode: 'shared', officeShared: office })).not.toHaveProperty('officeShared');
  expect(readConnectedAppsStatus({ ...status(), mailboxMode: 'everyone' })).not.toHaveProperty('mailboxMode');
});
