import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanyManagement, CompanyStatus } from "@shared/company-api";

// Persistent state/refs and dependency-aware effects across static renders.
const hooks = vi.hoisted(() => ({
  states: [] as unknown[], refs: [] as { current: unknown }[], deps: [] as (unknown[] | undefined)[],
  queued: [] as Array<() => unknown>, state: 0, ref: 0, effect: 0,
}));
vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const index = hooks.state++;
      if (!(index in hooks.states)) hooks.states[index] = initial;
      return [hooks.states[index], (value: unknown) => { hooks.states[index] = typeof value === "function" ? (value as (previous: unknown) => unknown)(hooks.states[index]) : value; }];
    },
    useRef: (initial: unknown) => { const index = hooks.ref++; return hooks.refs[index] ??= { current: initial }; },
    useEffect: (effect: () => unknown, deps?: unknown[]) => {
      const index = hooks.effect++;
      const previous = hooks.deps[index];
      if (!deps || !previous || deps.some((value, at) => !Object.is(value, previous[at]))) { hooks.deps[index] = deps; hooks.queued.push(effect); }
    },
  };
});
const api = vi.hoisted(() => ({ management: vi.fn(), revokeInvitation: vi.fn() }));
vi.mock("@/lib/company-api", () => ({ companyApi: { ...api, sessionVersion: () => 0, subscribeSession: () => () => undefined } }));

import { CompanyMembers } from "./CompanyMembers";

const owner = {
  storageAvailable: true, configured: true, setupAllowed: false, transport: "encrypted-company", limitations: [],
  company: { id: "company-1", name: "Example Realty Office" }, member: { id: "owner-1", displayName: "Olive Owner", role: "owner" },
} as CompanyStatus;
const page = (invitations: CompanyManagement["invitations"], members: CompanyManagement["members"] = []): CompanyManagement => ({ offset: 0, hasMore: false, unresolvedWork: false, members, invitations, transfer: null });
const invite = (id: string, expiresAt: string | null, extra: Partial<CompanyManagement["invitations"][number]> = {}) => ({ id, displayName: `Invitee ${id}`, expiresAt, redeemedAt: null, revokedAt: null, ...extra });

function render(refreshKey: number, view: "roster" | "membership" = "roster") {
  hooks.state = 0; hooks.ref = 0; hooks.effect = 0;
  return renderToStaticMarkup(createElement(CompanyMembers, { status: owner, refreshKey, onChanged: async () => undefined, view }));
}
const flush = () => { for (const effect of hooks.queued.splice(0)) effect(); };
const settle = async () => { for (let index = 0; index < 5; index++) await Promise.resolve(); };

beforeEach(() => {
  hooks.states.length = 0; hooks.refs.length = 0; hooks.deps.length = 0; hooks.queued.length = 0;
  api.management.mockReset();
});

describe("office members and invitations", () => {
  it("reloads when the office status is confirmed again, without a manual refresh", async () => {
    api.management.mockResolvedValueOnce(page([]));
    render(1); flush(); await settle();
    expect(api.management).toHaveBeenCalledTimes(1);
    expect(render(1)).toContain("People in this office");
    expect(render(1)).not.toContain("Invitations</h5>");
    flush();
    expect(api.management).toHaveBeenCalledTimes(1);

    api.management.mockResolvedValueOnce(page([], [{ id: "member-2", displayName: "New Member", role: "member", active: true, joinedAt: "2026-10-06T00:00:00.000Z" }]));
    render(2); flush(); await settle();
    expect(api.management).toHaveBeenCalledTimes(2);
    expect(render(2)).toContain("New Member");
  });

  it("does not offer to cancel an expired invitation", async () => {
    api.management.mockResolvedValueOnce(page([
      invite("a", "2000-01-01T00:00:00.000Z"),
      invite("b", "2999-01-01T00:00:00.000Z"),
      invite("c", null, { redeemedAt: "2026-10-01T00:00:00.000Z" }),
    ]));
    render(1); flush(); await settle();
    const html = render(1);
    expect(html).toContain("Invitee a · expired");
    expect(html).toContain("Invitee b · pending");
    expect(html).not.toContain("Invitee c");
    expect(html.match(/Cancel invitation/g)).toHaveLength(1);
    expect(html).toMatch(/Invitee b · pending<\/span><button[^>]*>Cancel invitation/);
  });

  it("keeps ownership transfer and leaving out of the owner's main people list", async () => {
    const people = page([], [{ id: "member-2", displayName: "New Member", role: "member", active: true, joinedAt: "2026-10-06T00:00:00.000Z" }]);
    api.management.mockResolvedValueOnce(people);
    render(1); flush(); await settle();
    const roster = render(1);
    expect(roster).toContain("New Member · member");
    expect(roster).toContain("Remove access");
    expect(roster).not.toMatch(/Offer ownership|Leave office|Refresh administration/);
    hooks.states.length = 0; hooks.refs.length = 0; hooks.deps.length = 0; hooks.queued.length = 0;
    api.management.mockResolvedValueOnce(people);
    render(1, "membership"); flush(); await settle();
    const membership = render(1, "membership");
    expect(membership).toContain("Membership and ownership</summary>");
    expect(membership).toContain("Offer ownership to New Member");
    expect(membership).toContain("Leave office");
    expect(membership).not.toContain("Remove access");
  });
});
