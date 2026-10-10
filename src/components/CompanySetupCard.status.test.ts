import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanyStatus, DepartmentPage } from "@shared/company-api";

// A minimal hook runtime: state and refs persist across static renders, and
// effects run only when their dependencies change, so the card's own
// refresh logic is exercised without a DOM.
const hooks = vi.hoisted(() => ({
  states: [] as unknown[], refs: [] as { current: unknown }[], deps: [] as (unknown[] | undefined)[], cleanups: [] as (unknown)[],
  queued: [] as Array<{ index: number; effect: () => unknown }>, state: 0, ref: 0, effect: 0,
}));
vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const index = hooks.state++;
      if (!(index in hooks.states)) hooks.states[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [hooks.states[index], (value: unknown) => { hooks.states[index] = typeof value === "function" ? (value as (previous: unknown) => unknown)(hooks.states[index]) : value; }];
    },
    useRef: (initial: unknown) => { const index = hooks.ref++; return hooks.refs[index] ??= { current: initial }; },
    useEffect: (effect: () => unknown, deps?: unknown[]) => {
      const index = hooks.effect++;
      const previous = hooks.deps[index];
      if (!deps || !previous || deps.some((value, at) => !Object.is(value, previous[at]))) { hooks.deps[index] = deps; hooks.queued.push({ index, effect }); }
    },
  };
});

const fixture = vi.hoisted(() => ({
  status: vi.fn(),
  check: null as null | (() => Promise<boolean | undefined>),
  members: [] as Array<{ refreshKey?: number }>,
  recovery: [] as Array<{ onChanged: () => Promise<unknown>; onRemoteHost?: (remote: boolean) => void; onAttention?: (needs: boolean) => void }>,
  departments: [] as Array<{ onAvailable?: (page: DepartmentPage | null) => void }>,
  departmentPage: vi.fn(),
  membersViews: [] as string[],
  localState: vi.fn(),
}));
vi.mock("@/lib/company-api", () => ({ companyApi: { status: fixture.status, departments: fixture.departmentPage, sessionVersion: () => 0, subscribeSession: () => () => undefined } }));
// The card binds department edits to this private workspace's identity before opening them.
vi.mock("@/state/store", () => ({ api: fixture.localState }));
vi.mock("@/lib/company-status-monitor", () => ({ monitorCompanyStatus: (options: { check: () => Promise<boolean | undefined> }) => { fixture.check = options.check; return () => undefined; } }));
vi.mock("./CompanyMembers", () => ({ CompanyMembers: (props: { refreshKey?: number; view?: string }) => { (props.view === "roster" ? fixture.membersViews : fixture.members).push(props as never); return null; } }));
vi.mock("./CompanyDepartments", () => ({ CompanyDepartments: (props: (typeof fixture.departments)[number]) => { fixture.departments.push(props); return null; } }));
vi.mock("./company/CompanyPortalBindingsCard", () => ({ CompanyPortalBindingsCard: () => null }));
vi.mock("./CompanyHostRecovery", () => ({ CompanyHostRecovery: () => null }));
vi.mock("./CompanyRecovery", () => ({ CompanyRecovery: (props: (typeof fixture.recovery)[number]) => { fixture.recovery.push(props); return null; } }));

import { CompanySetupCard } from "./CompanySetupCard";
const summaries: string[] = [];

const member: CompanyStatus = {
  storageAvailable: true, configured: true, setupAllowed: false, transport: "encrypted-company", limitations: [], remoteHost: true,
  company: { id: "company-1", name: "Example Realty Office" } as CompanyStatus["company"],
  member: { id: "member-1", displayName: "Sam Example", role: "member" } as CompanyStatus["member"],
};

function render() {
  hooks.state = 0; hooks.ref = 0; hooks.effect = 0;
  return renderToStaticMarkup(createElement(CompanySetupCard, { onSummary: (text: string) => { summaries.push(text); } }));
}
function flushEffects() {
  const queued = hooks.queued.splice(0);
  for (const { index, effect } of queued) {
    const cleanup = hooks.cleanups[index];
    if (typeof cleanup === "function") cleanup();
    hooks.cleanups[index] = effect();
  }
}
async function mount() {
  render(); flushEffects();
  await vi.waitFor(() => expect(fixture.status).toHaveBeenCalled());
  // status, then the private workspace identity for a signed-in member
  for (let tick = 0; tick < 5; tick++) await Promise.resolve();
  return render();
}
const deferred = <T,>() => { let resolve!: (value: T) => void, reject!: (cause: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

beforeEach(() => {
  hooks.states.length = 0; hooks.refs.length = 0; hooks.deps.length = 0; hooks.cleanups.length = 0; hooks.queued.length = 0;
  fixture.status.mockReset(); fixture.localState.mockReset(); fixture.localState.mockResolvedValue({ workspaceId: "fictional-workspace" }); fixture.departmentPage.mockReset(); fixture.departmentPage.mockReturnValue(new Promise(() => undefined)); fixture.check = null; fixture.members.length = 0; fixture.recovery.length = 0; fixture.departments.length = 0; fixture.membersViews.length = 0; summaries.length = 0;
  const target = new EventTarget();
  vi.stubGlobal("window", Object.assign(target, { location: { hash: "" } }));
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
});
afterEach(() => vi.unstubAllGlobals());

describe("office collaboration status checks", () => {
  it("keeps forms usable while a background check is running", async () => {
    fixture.status.mockResolvedValueOnce(member);
    const ready = await mount();
    expect(ready).toContain("Example Realty Office");
    const slow = deferred<CompanyStatus>();
    fixture.status.mockReturnValueOnce(slow.promise);
    const running = fixture.check!();
    const html = render();
    expect(html).not.toContain("Checking office…");
    expect(html).toContain('aria-busy="false"');
    expect(html).toContain(">Sign out of office</button>");
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Sign out of office<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Check company status<\/button>/);
    expect(html).toContain(">Check company status</button>");
    // A person's own check is not swallowed by the background one.
    fixture.status.mockResolvedValueOnce(member);
    await fixture.recovery.at(-1)!.onChanged();
    expect(fixture.status).toHaveBeenCalledTimes(3);
    slow.resolve(member); await running;
  });

  it("keeps the signed-in office when the host cannot be reached", async () => {
    fixture.status.mockResolvedValueOnce(member);
    await mount();
    fixture.status.mockRejectedValueOnce(new Error("Company status could not be checked. Try again when the local service is available."));
    await expect(fixture.check!()).resolves.toBe(false);
    const html = render();
    expect(html).toContain("Example Realty Office");
    expect(html).toContain("Sam Example");
    expect(html).toContain("Can’t reach the office host");
    expect(html).toContain("Last successful check:");
    expect(html).not.toContain("paste the join code");
    expect(html.match(/role="alert"/g)).toHaveLength(1);
    expect(html).toContain("Can’t reach the host? Disconnect this computer");
  });

  it("offers the offline disconnect review only for a remote host the recovery card confirms", async () => {
    fixture.status.mockResolvedValueOnce({ ...member, remoteHost: undefined, company: undefined, member: undefined });
    await mount();
    fixture.status.mockRejectedValueOnce(new Error("Company status could not be checked."));
    await fixture.check!();
    expect(render()).not.toContain("Disconnect this computer");
    fixture.recovery.at(-1)!.onRemoteHost!(true);
    expect(render()).toContain("Can’t reach the host? Disconnect this computer");
  });

  it("asks the member list to reload after each confirmed status check", async () => {
    fixture.status.mockResolvedValue(member);
    await mount();
    const first = fixture.members.at(-1)!.refreshKey!;
    await fixture.check!();
    render();
    expect(fixture.members.at(-1)!.refreshKey).toBe(first + 1);
  });

  it("points administrators to Service administration, not Advanced", async () => {
    fixture.status.mockResolvedValueOnce({ storageAvailable: true, configured: false, setupAllowed: false, transport: "local-only", limitations: [] });
    const html = await mount();
    expect(html).toContain(">Open service administration</a>");
    expect(html).toContain('href="#you-service-admin"');
    expect(html).not.toContain("under Advanced");
  });

  it("opens department edits only for the verified private workspace identity", async () => {
    fixture.status.mockResolvedValueOnce(member);
    fixture.localState.mockRejectedValueOnce(new Error("The private workspace identity could not be checked."));
    const html = await mount();
    expect(fixture.departments).toHaveLength(0);
    expect(html).toContain("The private workspace identity could not be checked.");
    expect(html).toContain("Use Check company status below to retry.");
  });
});

/** The part of the card before the folded Office settings. */
const mainView = (html: string) => html.slice(0, html.indexOf('data-office-settings'));

describe("office card main view", () => {
  it("offers two plain choices when this computer is not in an office", async () => {
    fixture.status.mockResolvedValueOnce({ storageAvailable: false, configured: false, setupAllowed: false, transport: "local-only", limitations: [], remoteJoinAvailable: true });
    const html = await mount();
    expect(html).toContain(">Join an office</button>");
    expect(html).toContain(">Host the office on this computer</button>");
    expect(html).not.toContain("Use on my own");
    expect(html).toMatch(/<details class="[^"]*" data-office-settings="">/);
    flushEffects();
    expect(summaries.at(-1)).toBe("Not set up");
  });

  it("shows a joined member four status lines and folds everything else", async () => {
    fixture.status.mockResolvedValueOnce(member);
    await mount();
    const department = (name: string, access: "none" | "read" | "write", retiredAt: string | null = null) => ({ id: name, name, revision: "1", access, retiredAt, retiredBy: null, retirementNote: "", unresolvedCases: 0 });
    fixture.departments.at(-1)!.onAvailable!({ departments: [department("Accounts", "read"), department("Leasing", "write"), department("Sales", "none"), department("Old", "read", "2026-01-01T00:00:00.000Z")], canManage: false, offset: 0, hasMore: false });
    fixture.recovery.at(-1)!.onAttention!(false);
    const html = render();
    const main = mainView(html);
    expect(main).toContain(">Office host</dt>");
    expect(main).toContain(">Connected</dd>");
    expect(main).toContain("Sam Example (member)");
    expect(main).toContain(">This computer</dt>");
    expect(main).toContain(">Ready</dd>");
    expect(main).toContain("Accounts, Leasing");
    expect(main).not.toMatch(/Sign out|Check company status|certificate|fingerprint|Invite someone/i);
    expect(fixture.membersViews).toHaveLength(0);
    expect(html).toContain(">Sign out of office</button>");
    flushEffects();
    expect(summaries.at(-1)).toBe("Joined Example Realty Office");
  });

  it("flags recovery that needs attention on the main view, with a way to open it", async () => {
    fixture.status.mockResolvedValueOnce(member);
    await mount();
    fixture.recovery.at(-1)!.onAttention!(true);
    const main = mainView(render());
    expect(main).toContain("Needs attention");
    expect(main).toContain(">Review</button>");
    flushEffects();
    expect(summaries.at(-1)).toBe("Joined Example Realty Office · needs attention");
  });

  it("gives the owner the people list and an invite, and counts people for the Workspace row", async () => {
    fixture.status.mockResolvedValueOnce({ ...member, remoteHost: false, hostingAvailable: true, networkEnabled: true, member: { id: "owner-1", displayName: "Olive Owner", role: "owner" } as CompanyStatus["member"] });
    await mount();
    expect(fixture.membersViews.length).toBeGreaterThan(0);
    (fixture.membersViews.at(-1) as unknown as { onCount: (active: number, more: boolean) => void }).onCount(3, false);
    const main = mainView(render());
    expect(main).toContain(">Invite someone</summary>");
    expect(main).toContain(">This computer</dd>");
    expect(main).not.toContain("Show host code");
    flushEffects();
    expect(summaries.at(-1)).toBe("Hosting · 3 people");
  });

  it("rereads departments on each confirmed status check and keeps the last list when a read fails", async () => {
    fixture.status.mockResolvedValue(member);
    fixture.departmentPage.mockResolvedValueOnce({ departments: [{ id: "a", name: "Accounts", revision: "1", access: "read", retiredAt: null, retiredBy: null, retirementNote: "", unresolvedCases: 0 }], canManage: false, offset: 0, hasMore: false });
    await mount(); flushEffects(); await Promise.resolve(); await Promise.resolve();
    expect(mainView(render())).toContain("Accounts");
    fixture.departmentPage.mockRejectedValueOnce(new Error("offline"));
    await fixture.check!(); render(); flushEffects(); await Promise.resolve(); await Promise.resolve();
    expect(fixture.departmentPage).toHaveBeenCalledTimes(2);
    expect(mainView(render())).toContain("Accounts");
  });
});
